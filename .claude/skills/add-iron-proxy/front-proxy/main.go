// NanoClaw's approval boundary. Iron remains an unmodified credential injector.
package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"syscall"
	"time"

	pb "github.com/ironsh/iron-proxy/gen/transform/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
)

type config struct {
	Listen         string   `json:"listen"`
	Backend        string   `json:"backend"`
	CACert         string   `json:"ca_cert"`
	CAKey          string   `json:"ca_key"`
	IdentityKey    string   `json:"identity_key"`
	AllowedHosts   []string `json:"allowed_hosts"`
	ApprovalTarget string   `json:"approval_target"`
	ApprovalCert   string   `json:"approval_cert"`
	ApprovalKey    string   `json:"approval_key"`
	SummaryCommand string   `json:"summary_command"`
	TimeoutMS      int      `json:"timeout_ms"`
}

type gateway struct {
	cfg       config
	ca        tls.Certificate
	signer    *rsa.PrivateKey
	key       []byte
	bridge    pb.TransformServiceClient
	transport *http.Transport
	// Stock Iron turns a backend tunnel into a raw relay for every upgrade
	// request, whatever the origin answers. A pooled connection that carried a
	// rejected upgrade would bypass Iron's transforms for every later request
	// (the Codex CLI got unaudited 401s until the origin dropped it), so upgrades
	// use connections that are never reused.
	upgrades *http.Transport
}

func newGateway(cfg config, bridge pb.TransformServiceClient) (*gateway, error) {
	ca, err := tls.LoadX509KeyPair(cfg.CACert, cfg.CAKey)
	if err != nil {
		return nil, err
	}
	ca.Leaf, err = x509.ParseCertificate(ca.Certificate[0])
	if err != nil {
		return nil, err
	}
	key, err := os.ReadFile(cfg.IdentityKey)
	if err != nil {
		return nil, err
	}
	if len(key) < 32 {
		return nil, errors.New("identity key too short")
	}
	signer, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return nil, err
	}
	backend, err := url.Parse(cfg.Backend)
	if err != nil {
		return nil, err
	}
	// Backend must be inaccessible from agent networks, even after managed reloads.
	if backend.Scheme != "http" || backend.Hostname() != "127.0.0.1" || backend.Port() == "" {
		return nil, errors.New("backend must be a loopback HTTP proxy")
	}
	roots, err := x509.SystemCertPool()
	if err != nil {
		roots = x509.NewCertPool()
	}
	certPEM, err := os.ReadFile(cfg.CACert)
	if err != nil {
		return nil, err
	}
	if !roots.AppendCertsFromPEM(certPEM) {
		return nil, errors.New("invalid CA")
	}
	if cfg.TimeoutMS <= 0 || cfg.TimeoutMS > 300000 {
		return nil, errors.New("invalid approval timeout")
	}
	// DisableCompression: the front never negotiates gzip on the client's behalf.
	// Go's transparent decompression would strip Content-Length, and the tunnel
	// then writes a body no client can delimit (the Codex CLI's reqwest hung there).
	transport := &http.Transport{Proxy: http.ProxyURL(backend), TLSClientConfig: &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}, ForceAttemptHTTP2: false, DisableCompression: true, ResponseHeaderTimeout: 5 * time.Minute, MaxIdleConns: 100, IdleConnTimeout: 90 * time.Second}
	upgrades := transport.Clone()
	upgrades.DisableKeepAlives = true
	return &gateway{cfg: cfg, ca: ca, signer: signer, key: key, bridge: bridge, transport: transport, upgrades: upgrades}, nil
}

func (g *gateway) identity(r *http.Request) (string, error) {
	values := r.Header.Values("Proxy-Authorization")
	if len(values) != 1 {
		return "", errors.New("one proxy identity required")
	}
	scheme, encoded, ok := strings.Cut(values[0], " ")
	if !ok || !strings.EqualFold(scheme, "Basic") {
		return "", errors.New("invalid authentication")
	}
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return "", err
	}
	user, token, ok := strings.Cut(string(raw), ":")
	if !ok || user != "workload" || len(token) > 8192 {
		return "", errors.New("invalid identity")
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 || parts[0] != "iw1" {
		return "", errors.New("invalid token")
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return "", err
	}
	mac := hmac.New(sha256.New, g.key)
	mac.Write([]byte(parts[0] + "." + parts[1]))
	if !hmac.Equal(signature, mac.Sum(nil)) {
		return "", errors.New("invalid signature")
	}
	identity, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || len(identity) == 0 || len(identity) > 512 || strings.IndexFunc(string(identity), func(c rune) bool { return c < 32 || c == 127 }) >= 0 {
		return "", errors.New("invalid identity")
	}
	return string(identity), nil
}

func authority(raw, scheme string) (string, error) {
	if strings.ContainsAny(raw, "/@?#\\ \t\r\n") {
		return "", errors.New("invalid authority")
	}
	u, err := url.Parse(scheme + "://" + raw)
	if err != nil || u.Hostname() == "" {
		return "", errors.New("invalid authority")
	}
	port := u.Port()
	if port == "" {
		if scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	}
	return net.JoinHostPort(strings.ToLower(u.Hostname()), port), nil
}

func (g *gateway) allowed(host string) bool {
	host = strings.ToLower(host)
	for _, pattern := range g.cfg.AllowedHosts {
		pattern = strings.ToLower(pattern)
		if host == pattern {
			return true
		}
		if strings.HasPrefix(pattern, "*.") && strings.HasSuffix(host, pattern[1:]) && host != pattern[2:] {
			return true
		}
	}
	return false
}

func safeRequest(r *http.Request) *pb.HttpRequest {
	u := *r.URL
	u.RawQuery = ""
	u.ForceQuery = false
	u.Fragment = ""
	u.User = nil
	return &pb.HttpRequest{Method: r.Method, Url: u.String(), Host: r.URL.Host}
}

func (g *gateway) approve(ctx context.Context, r *http.Request, identity string) (bool, error) {
	ctx, cancel := context.WithTimeout(ctx, time.Duration(g.cfg.TimeoutMS)*time.Millisecond)
	defer cancel()
	ctx = metadata.AppendToOutgoingContext(ctx, "x-iron-workload-identity", identity)
	if r.Method != "CONNECT" {
		summary, err := g.summarize(ctx, r)
		if err != nil {
			return false, err
		}
		ctx = metadata.AppendToOutgoingContext(ctx, "x-iron-approval-summary", base64.StdEncoding.EncodeToString(summary))
	}
	reply, err := g.bridge.TransformRequest(ctx, &pb.TransformRequestRequest{Request: safeRequest(r)})
	// No custom responses or request mutations are accepted from the decision service.
	return err == nil && reply != nil && reply.Action == pb.TransformAction_TRANSFORM_ACTION_CONTINUE && reply.Response == nil && reply.ModifiedRequest == nil, err
}

func (g *gateway) summarize(ctx context.Context, r *http.Request) ([]byte, error) {
	if g.cfg.SummaryCommand == "" {
		return nil, errors.New("summary helper required")
	}
	prefix := []byte{}
	if r.Body != nil {
		var err error
		prefix, err = io.ReadAll(io.LimitReader(r.Body, 16384))
		if err != nil {
			return nil, err
		}
		r.Body = &prefixBody{Reader: io.MultiReader(bytes.NewReader(prefix), r.Body), Closer: r.Body}
	}
	input, err := json.Marshal(map[string]any{"host": r.URL.Hostname(), "method": r.Method, "path": r.URL.EscapedPath(), "content_type": r.Header.Get("Content-Type"), "body": base64.StdEncoding.EncodeToString(prefix)})
	if err != nil {
		return nil, err
	}
	helperCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(helperCtx, g.cfg.SummaryCommand)
	cmd.Stdin = bytes.NewReader(input)
	output := &boundedBuffer{limit: 32768}
	cmd.Stdout = output
	if err = cmd.Run(); err != nil {
		return nil, errors.New("summary helper failed")
	}
	if !json.Valid(output.Bytes()) {
		return nil, errors.New("invalid summary")
	}
	return output.Bytes(), nil
}

type prefixBody struct {
	io.Reader
	io.Closer
}
type boundedBuffer struct {
	bytes.Buffer
	limit int
}

func (b *boundedBuffer) Write(p []byte) (int, error) {
	if b.Len()+len(p) > b.limit {
		return 0, errors.New("summary too large")
	}
	return b.Buffer.Write(p)
}

func stripHopHeaders(h http.Header) {
	for name := range h {
		if strings.HasPrefix(strings.ToLower(name), "x-iron-") {
			h.Del(name)
		}
	}
	for _, value := range h.Values("Connection") {
		for _, name := range strings.Split(value, ",") {
			h.Del(strings.TrimSpace(name))
		}
	}
	for _, name := range []string{"Connection", "Proxy-Connection", "Proxy-Authorization", "Proxy-Authenticate", "Keep-Alive", "TE", "Trailer", "Transfer-Encoding", "Upgrade"} {
		h.Del(name)
	}
}

func deny(r *http.Request, status int) *http.Response {
	return &http.Response{StatusCode: status, Status: fmt.Sprintf("%d %s", status, http.StatusText(status)), Proto: "HTTP/1.1", ProtoMajor: 1, ProtoMinor: 1, Header: http.Header{"Content-Type": []string{"text/plain"}}, Body: io.NopCloser(strings.NewReader(http.StatusText(status) + "\n")), ContentLength: -1, Request: r, Close: true}
}

func (g *gateway) forward(r *http.Request, identity, tunnel string) *http.Response {
	if r.Method == "CONNECT" || r.URL.User != nil || (r.URL.Scheme != "http" && r.URL.Scheme != "https") || (r.Header.Get("Upgrade") != "" && !strings.EqualFold(r.Header.Get("Upgrade"), "websocket")) {
		return deny(r, 403)
	}
	target, err := authority(r.URL.Host, r.URL.Scheme)
	if err != nil {
		return deny(r, 403)
	}
	requested, err := authority(r.Host, r.URL.Scheme)
	if err != nil || requested != target || (tunnel != "" && (target != tunnel || r.URL.Scheme != "https")) {
		return deny(r, 403)
	}
	if !g.allowed(r.URL.Hostname()) {
		return deny(r, 403)
	}
	if ok, err := g.approve(r.Context(), r, identity); err != nil || !ok {
		return deny(r, 403)
	}
	out := r.Clone(r.Context())
	out.RequestURI = ""
	out.Header = r.Header.Clone()
	stripHopHeaders(out.Header)
	transport := g.transport
	if strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		out.Header.Set("Connection", "Upgrade")
		out.Header.Set("Upgrade", "websocket")
		transport = g.upgrades
	}
	resp, err := transport.RoundTrip(out)
	if err != nil {
		return deny(r, 502)
	}
	ctx, cancel := context.WithTimeout(r.Context(), time.Duration(g.cfg.TimeoutMS)*time.Millisecond)
	defer cancel()
	ctx = metadata.AppendToOutgoingContext(ctx, "x-iron-workload-identity", identity)
	decision, err := g.bridge.TransformResponse(ctx, &pb.TransformResponseRequest{Request: safeRequest(r), Response: &pb.HttpResponse{StatusCode: int32(resp.StatusCode)}})
	if err != nil || decision == nil || decision.Action != pb.TransformAction_TRANSFORM_ACTION_CONTINUE || decision.ModifiedResponse != nil {
		resp.Body.Close()
		return deny(r, 403)
	}
	stripHopHeaders(resp.Header)
	if resp.StatusCode == 101 {
		if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
			resp.Body.Close()
			return deny(r, 403)
		}
		resp.Header.Set("Connection", "Upgrade")
		resp.Header.Set("Upgrade", "websocket")
	}
	return resp
}

func (g *gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	identity, err := g.identity(r)
	if err != nil {
		http.Error(w, "Proxy authentication required", 407)
		return
	}
	r.Header.Del("Proxy-Authorization")
	if r.Method == "CONNECT" {
		g.connect(w, r, identity)
		return
	}
	if r.Body != nil {
		r.Body = &deadlineBody{ReadCloser: r.Body, setDeadline: http.NewResponseController(w).SetReadDeadline}
	}
	resp := g.forward(r, identity, "")
	http.NewResponseController(w).SetReadDeadline(time.Time{})
	defer resp.Body.Close()
	if resp.StatusCode == 101 {
		h, ok := w.(http.Hijacker)
		if !ok {
			return
		}
		conn, buf, err := h.Hijack()
		if err != nil {
			return
		}
		defer conn.Close()
		relayUpgrade(&bufferedConn{Conn: conn, reader: buf.Reader}, resp)
		return
	}
	for k, values := range resp.Header {
		for _, v := range values {
			w.Header().Add(k, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	io.Copy(flushWriter{w}, resp.Body)
}

type bufferedConn struct {
	net.Conn
	reader *bufio.Reader
}

func (c *bufferedConn) Read(p []byte) (int, error) { return c.reader.Read(p) }

func (g *gateway) connect(w http.ResponseWriter, r *http.Request, identity string) {
	target, err := authority(r.Host, "https")
	if err != nil {
		http.Error(w, "Forbidden", 403)
		return
	}
	host, _, _ := net.SplitHostPort(target)
	if !g.allowed(host) {
		http.Error(w, "Forbidden", 403)
		return
	}
	check := r.Clone(r.Context())
	check.URL = &url.URL{Scheme: "https", Host: r.Host}
	check.Host = r.Host
	if ok, err := g.approve(r.Context(), check, identity); err != nil || !ok {
		http.Error(w, "Forbidden", 403)
		return
	}
	cert, err := g.certificate(host)
	if err != nil {
		http.Error(w, "Certificate unavailable", 503)
		return
	}
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "Unsupported transport", 503)
		return
	}
	raw, buffer, err := hijacker.Hijack()
	if err != nil {
		return
	}
	defer raw.Close()
	if _, err = buffer.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil {
		return
	}
	if err = buffer.Flush(); err != nil {
		return
	}
	conn := tls.Server(&bufferedConn{Conn: raw, reader: buffer.Reader}, &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12, NextProtos: []string{"http/1.1"}, GetConfigForClient: func(hello *tls.ClientHelloInfo) (*tls.Config, error) {
		if hello.ServerName != "" && !strings.EqualFold(hello.ServerName, host) {
			return nil, errors.New("SNI differs from tunnel authority")
		}
		return nil, nil
	}})
	raw.SetDeadline(time.Now().Add(15 * time.Second))
	if err = conn.HandshakeContext(r.Context()); err != nil {
		return
	}
	raw.SetDeadline(time.Time{})
	reader := bufio.NewReaderSize(conn, 65536)
	for {
		raw.SetReadDeadline(time.Now().Add(30 * time.Second))
		inner, err := readTunnelRequest(reader, conn)
		if err != nil {
			return
		}
		inner = inner.WithContext(r.Context())
		if inner.Body != nil {
			inner.Body = &deadlineBody{ReadCloser: inner.Body, setDeadline: raw.SetReadDeadline}
		}
		if inner.URL.IsAbs() {
			inner.Body.Close()
			return
		}
		inner.URL.Scheme = "https"
		inner.URL.Host = inner.Host
		// A CONNECT capability is immutable for the entire tunnel; inner credentials cannot replace it.
		if len(inner.Header.Values("Proxy-Authorization")) > 0 {
			inner.Body.Close()
			deny(inner, 403).Write(conn)
			return
		}
		resp := g.forward(inner, identity, target)
		raw.SetReadDeadline(time.Time{})
		if resp.StatusCode == 101 {
			relayUpgrade(&bufferedConn{Conn: conn, reader: reader}, resp)
			inner.Body.Close()
			return
		}
		if err = resp.Write(conn); err != nil {
			resp.Body.Close()
			inner.Body.Close()
			return
		}
		resp.Body.Close()
		inner.Body.Close()
		if resp.Close || inner.Close {
			return
		}
	}
}

// Bound every tunneled header independently. Replaying only the checked header
// and already buffered bytes preserves body framing and pipelined requests.
func readTunnelRequest(reader *bufio.Reader, conn net.Conn) (*http.Request, error) {
	var header bytes.Buffer
	for {
		line, err := reader.ReadSlice('\n')
		if err != nil {
			return nil, err
		}
		if header.Len()+len(line) > 65536 {
			return nil, errors.New("request headers too large")
		}
		header.Write(line)
		if bytes.Equal(line, []byte("\r\n")) || bytes.Equal(line, []byte("\n")) {
			break
		}
	}
	buffered := make([]byte, reader.Buffered())
	if _, err := io.ReadFull(reader, buffered); err != nil {
		return nil, err
	}
	reader.Reset(io.MultiReader(bytes.NewReader(header.Bytes()), bytes.NewReader(buffered), conn))
	return http.ReadRequest(reader)
}

type deadlineBody struct {
	io.ReadCloser
	setDeadline func(time.Time) error
}

func (b *deadlineBody) Read(p []byte) (int, error) {
	if err := b.setDeadline(time.Now().Add(30 * time.Second)); err != nil && !errors.Is(err, http.ErrNotSupported) {
		return 0, err
	}
	return b.ReadCloser.Read(p)
}

type flushWriter struct{ http.ResponseWriter }

func (w flushWriter) Write(p []byte) (int, error) {
	n, err := w.ResponseWriter.Write(p)
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
	return n, err
}

// The whole 101 handshake in one write. Per-line writes become one TLS record
// each, and tungstenite (the Codex CLI's WebSocket client) aborts a handshake
// that takes more than ten reads with "Attack attempt detected".
func writeUpgradeResponse(w io.Writer, header http.Header) error {
	var buf bytes.Buffer
	buf.WriteString("HTTP/1.1 101 Switching Protocols\r\n")
	header.Write(&buf)
	buf.WriteString("\r\n")
	_, err := w.Write(buf.Bytes())
	return err
}

// Switch protocols only after both decisions. Socket bytes belong to this
// authorized upgrade; they cannot be reinterpreted as unapproved HTTP requests.
func relayUpgrade(client net.Conn, resp *http.Response) {
	upstream, ok := resp.Body.(io.ReadWriteCloser)
	if !ok {
		resp.Body.Close()
		return
	}
	defer upstream.Close()
	if err := writeUpgradeResponse(client, resp.Header); err != nil {
		return
	}
	done := make(chan struct{}, 2)
	go func() { io.Copy(upstream, client); done <- struct{}{} }()
	go func() { io.Copy(client, upstream); done <- struct{}{} }()
	<-done
	client.Close()
	upstream.Close()
	<-done
}

func (g *gateway) certificate(host string) (tls.Certificate, error) {
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return tls.Certificate{}, err
	}
	tmpl := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: host}, NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(24 * time.Hour), KeyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	if ip := net.ParseIP(host); ip != nil {
		tmpl.IPAddresses = []net.IP{ip}
	} else {
		tmpl.DNSNames = []string{host}
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, g.ca.Leaf, &g.signer.PublicKey, g.ca.PrivateKey)
	if err != nil {
		return tls.Certificate{}, err
	}
	return tls.X509KeyPair(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(g.signer)}))
}

func main() {
	file := flag.String("config", "/etc/iron-proxy/front.json", "front proxy configuration")
	backendConfig := flag.String("iron-config", "/etc/iron-proxy/config.yaml", "stock Iron configuration")
	flag.Parse()
	raw, err := os.ReadFile(*file)
	if err != nil {
		log.Fatal(err)
	}
	var cfg config
	if err = json.Unmarshal(raw, &cfg); err != nil {
		log.Fatal(err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	var transport credentials.TransportCredentials
	if strings.HasPrefix(cfg.ApprovalTarget, "unix:") {
		transport = insecure.NewCredentials()
	} else {
		roots := x509.NewCertPool()
		ca, err := os.ReadFile(cfg.CACert)
		if err != nil {
			log.Fatal(err)
		}
		if !roots.AppendCertsFromPEM(ca) {
			log.Fatal("invalid approval CA")
		}
		cert, err := tls.LoadX509KeyPair(cfg.ApprovalCert, cfg.ApprovalKey)
		if err != nil {
			log.Fatal(err)
		}
		transport = credentials.NewTLS(&tls.Config{RootCAs: roots, Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12})
	}
	channel, err := grpc.NewClient(cfg.ApprovalTarget, grpc.WithTransportCredentials(transport), grpc.WithDefaultCallOptions(grpc.MaxCallRecvMsgSize(65536)))
	if err != nil {
		log.Fatal(err)
	}
	defer channel.Close()
	g, err := newGateway(cfg, pb.NewTransformServiceClient(channel))
	if err != nil {
		log.Fatal(err)
	}
	iron := exec.Command("/usr/local/bin/iron-proxy", "-config", *backendConfig)
	iron.Stdout = os.Stdout
	iron.Stderr = os.Stderr
	if err = iron.Start(); err != nil {
		log.Fatal(err)
	}
	exited := make(chan error, 1)
	go func() { exited <- iron.Wait(); stop() }()
	// Do not publish the front listener until the stock backend has a listener.
	backendURL, _ := url.Parse(cfg.Backend)
	readyDeadline := time.Now().Add(30 * time.Second)
	for {
		conn, dialErr := net.DialTimeout("tcp", backendURL.Host, time.Second)
		if dialErr == nil {
			conn.Close()
			break
		}
		if ctx.Err() != nil || time.Now().After(readyDeadline) {
			iron.Process.Kill()
			log.Fatal("stock Iron backend unavailable")
		}
		time.Sleep(100 * time.Millisecond)
	}
	server := &http.Server{Addr: cfg.Listen, Handler: g, ReadHeaderTimeout: 15 * time.Second, ReadTimeout: 30 * time.Second, IdleTimeout: 90 * time.Second, MaxHeaderBytes: 65536}
	go func() {
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Print("front proxy stopped")
			stop()
		}
	}()
	<-ctx.Done()
	server.Close()
	g.transport.CloseIdleConnections()
	g.upgrades.CloseIdleConnections()
	iron.Process.Signal(syscall.SIGTERM)
	select {
	case <-exited:
	case <-time.After(5 * time.Second):
		iron.Process.Kill()
	}
}
