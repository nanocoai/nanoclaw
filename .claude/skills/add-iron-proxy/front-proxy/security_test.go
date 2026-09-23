package main

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"fmt"
	pb "github.com/ironsh/iron-proxy/gen/transform/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/metadata"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type fixtureBridge struct {
	request  func(context.Context, *pb.TransformRequestRequest) (*pb.TransformRequestResponse, error)
	response func(context.Context, *pb.TransformResponseRequest) (*pb.TransformResponseResponse, error)
}

func (b *fixtureBridge) TransformRequest(c context.Context, r *pb.TransformRequestRequest, _ ...grpc.CallOption) (*pb.TransformRequestResponse, error) {
	if b.request != nil {
		return b.request(c, r)
	}
	return &pb.TransformRequestResponse{Action: pb.TransformAction_TRANSFORM_ACTION_CONTINUE}, nil
}
func (b *fixtureBridge) TransformResponse(c context.Context, r *pb.TransformResponseRequest, _ ...grpc.CallOption) (*pb.TransformResponseResponse, error) {
	if b.response != nil {
		return b.response(c, r)
	}
	return &pb.TransformResponseResponse{Action: pb.TransformAction_TRANSFORM_ACTION_CONTINUE}, nil
}
func fixture(t *testing.T, b *fixtureBridge, handler http.Handler) (*gateway, *httptest.Server) {
	t.Helper()
	dir := t.TempDir()
	key, e := rsa.GenerateKey(rand.Reader, 2048)
	if e != nil {
		t.Fatal(e)
	}
	ca := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "fixture"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature}
	der, e := x509.CreateCertificate(rand.Reader, ca, ca, &key.PublicKey, key)
	if e != nil {
		t.Fatal(e)
	}
	cert := filepath.Join(dir, "ca.pem")
	priv := filepath.Join(dir, "ca.key")
	identity := filepath.Join(dir, "identity.key")
	helper := filepath.Join(dir, "summary")
	os.WriteFile(cert, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0600)
	os.WriteFile(priv, pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}), 0600)
	os.WriteFile(identity, bytes.Repeat([]byte("k"), 32), 0600)
	os.WriteFile(helper, []byte("#!/bin/sh\ncat >/dev/null\nprintf '{}'\n"), 0700)
	backend := httptest.NewServer(handler)
	t.Cleanup(backend.Close)
	g, e := newGateway(config{Backend: backend.URL, CACert: cert, CAKey: priv, IdentityKey: identity, AllowedHosts: []string{"api.example.test"}, SummaryCommand: helper, TimeoutMS: 2000}, b)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(g.transport.CloseIdleConnections)
	t.Cleanup(g.upgrades.CloseIdleConnections)
	return g, backend
}
func auth(g *gateway, identity string) string {
	unsigned := "iw1." + base64.RawURLEncoding.EncodeToString([]byte(identity))
	mac := hmac.New(sha256.New, g.key)
	mac.Write([]byte(unsigned))
	token := unsigned + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return "Basic " + base64.StdEncoding.EncodeToString([]byte("workload:"+token))
}
func request(g *gateway, body io.Reader) *http.Request {
	r := httptest.NewRequest("POST", "http://api.example.test/resource", body)
	r.Header.Set("Proxy-Authorization", auth(g, "session-A"))
	return r
}
func TestDecisionFailuresNeverReachBackend(t *testing.T) {
	for _, name := range []string{"empty", "nil", "unknown", "reject", "error", "timeout", "mutation", "synthetic-response"} {
		t.Run(name, func(t *testing.T) {
			var hits atomic.Int32
			b := &fixtureBridge{request: func(ctx context.Context, r *pb.TransformRequestRequest) (*pb.TransformRequestResponse, error) {
				switch name {
				case "nil":
					return nil, nil
				case "unknown":
					return &pb.TransformRequestResponse{Action: pb.TransformAction(999)}, nil
				case "reject":
					return &pb.TransformRequestResponse{Action: pb.TransformAction_TRANSFORM_ACTION_REJECT}, nil
				case "error":
					return nil, errors.New("offline")
				case "timeout":
					<-ctx.Done()
					return nil, ctx.Err()
				case "mutation":
					return &pb.TransformRequestResponse{Action: pb.TransformAction_TRANSFORM_ACTION_CONTINUE, ModifiedRequest: &pb.HttpRequest{}}, nil
				case "synthetic-response":
					return &pb.TransformRequestResponse{Action: pb.TransformAction_TRANSFORM_ACTION_CONTINUE, Response: &pb.HttpResponse{}}, nil
				}
				return &pb.TransformRequestResponse{}, nil
			}}
			g, _ := fixture(t, b, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits.Add(1); w.WriteHeader(200) }))
			w := httptest.NewRecorder()
			g.ServeHTTP(w, request(g, nil))
			if w.Code != 403 || hits.Load() != 0 {
				t.Fatalf("status=%d upstream=%d", w.Code, hits.Load())
			}
		})
	}
}
func TestRequestBodyAndMetadataBoundary(t *testing.T) {
	body := bytes.Repeat([]byte("stream-body-"), 20000)
	var got []byte
	var headers http.Header
	b := &fixtureBridge{request: func(ctx context.Context, r *pb.TransformRequestRequest) (*pb.TransformRequestResponse, error) {
		m, _ := metadata.FromOutgoingContext(ctx)
		if strings.Join(m.Get("x-iron-workload-identity"), "") != "session-A" {
			t.Error("identity forged")
		}
		if len(r.Request.Headers) != 0 || len(r.Request.Body) != 0 || strings.Contains(r.Request.Url, "secret") {
			t.Error("request leaked to bridge")
		}
		return &pb.TransformRequestResponse{Action: pb.TransformAction_TRANSFORM_ACTION_CONTINUE}, nil
	}}
	g, _ := fixture(t, b, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got, _ = io.ReadAll(r.Body)
		headers = r.Header.Clone()
		w.Write([]byte("ok"))
	}))
	r := request(g, bytes.NewReader(body))
	r.URL.RawQuery = "secret=fixture"
	r.Header.Set("Authorization", "placeholder")
	r.Header.Set("X-Iron-Workload-Identity", "forged")
	r.Header.Set("X-Iron-Approval-Summary", "forged")
	r.Header.Set("Connection", "X-Remove")
	r.Header.Set("X-Remove", "remove")
	w := httptest.NewRecorder()
	g.ServeHTTP(w, r)
	if w.Code != 200 || !bytes.Equal(got, body) {
		t.Fatalf("status=%d body length=%d", w.Code, len(got))
	}
	for _, h := range []string{"Proxy-Authorization", "X-Iron-Workload-Identity", "X-Iron-Approval-Summary", "X-Remove"} {
		if headers.Get(h) != "" {
			t.Errorf("leaked %s", h)
		}
	}
	if headers.Get("Authorization") != "placeholder" {
		t.Error("credential placeholder removed")
	}
}
func TestResponseDecisionFailsClosed(t *testing.T) {
	for _, name := range []string{"empty", "unknown", "nil", "error", "modified"} {
		t.Run(name, func(t *testing.T) {
			b := &fixtureBridge{response: func(context.Context, *pb.TransformResponseRequest) (*pb.TransformResponseResponse, error) {
				switch name {
				case "nil":
					return nil, nil
				case "error":
					return nil, errors.New("offline")
				case "unknown":
					return &pb.TransformResponseResponse{Action: pb.TransformAction(999)}, nil
				case "modified":
					return &pb.TransformResponseResponse{Action: pb.TransformAction_TRANSFORM_ACTION_CONTINUE, ModifiedResponse: &pb.HttpResponse{}}, nil
				}
				return &pb.TransformResponseResponse{}, nil
			}}
			g, _ := fixture(t, b, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("private upstream response")) }))
			w := httptest.NewRecorder()
			g.ServeHTTP(w, request(g, nil))
			if w.Code != 403 || strings.Contains(w.Body.String(), "private") {
				t.Fatalf("response exposed: %d", w.Code)
			}
		})
	}
}
func TestAuthorityAndIdentityRejection(t *testing.T) {
	g, _ := fixture(t, &fixtureBridge{}, http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Error("rejected request reached backend") }))
	for _, name := range []string{"missing", "forged", "duplicate", "host-mismatch", "loopback", "upgrade"} {
		t.Run(name, func(t *testing.T) {
			r := request(g, nil)
			switch name {
			case "missing":
				r.Header.Del("Proxy-Authorization")
			case "forged":
				r.Header.Set("Proxy-Authorization", auth(g, "session-A")+"x")
			case "duplicate":
				r.Header.Add("Proxy-Authorization", auth(g, "session-B"))
			case "host-mismatch":
				r.Host = "elsewhere.test"
			case "loopback":
				r.URL, _ = url.Parse("http://127.0.0.1:18080/")
				r.Host = r.URL.Host
			case "upgrade":
				r.Header.Set("Upgrade", "unsupported")
			}
			w := httptest.NewRecorder()
			g.ServeHTTP(w, r)
			if w.Code < 400 {
				t.Fatalf("accepted %s", name)
			}
		})
	}
}
func TestBackendOutageHasNoDirectFallback(t *testing.T) {
	g, backend := fixture(t, &fixtureBridge{}, http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Error("unexpected request") }))
	backend.Close()
	w := httptest.NewRecorder()
	g.ServeHTTP(w, request(g, nil))
	if w.Code != 502 {
		t.Fatalf("status=%d", w.Code)
	}
}
func tunnel(t *testing.T, g *gateway, sni string) (net.Conn, *bufio.Reader, error) {
	t.Helper()
	front := httptest.NewServer(g)
	t.Cleanup(front.Close)
	u, _ := url.Parse(front.URL)
	raw, e := net.Dial("tcp", u.Host)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { raw.Close() })
	raw.SetDeadline(time.Now().Add(3 * time.Second))
	io.WriteString(raw, "CONNECT api.example.test:443 HTTP/1.1\r\nHost: api.example.test:443\r\nProxy-Authorization: "+auth(g, "session-A")+"\r\n\r\n")
	reader := bufio.NewReader(raw)
	response, e := http.ReadResponse(reader, &http.Request{Method: "CONNECT"})
	if e != nil {
		t.Fatal(e)
	}
	if response.StatusCode != 200 {
		t.Fatalf("connect=%d", response.StatusCode)
	}
	tlsConn := tls.Client(raw, &tls.Config{InsecureSkipVerify: true, ServerName: sni})
	e = tlsConn.Handshake()
	return tlsConn, bufio.NewReader(tlsConn), e
}
func TestTunnelRejectsMismatchedSNI(t *testing.T) {
	g, _ := fixture(t, &fixtureBridge{}, http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Error("unexpected backend request") }))
	_, _, e := tunnel(t, g, "different.example.test")
	if e == nil {
		t.Fatal("accepted mismatched TLS SNI")
	}
}
func TestTunnelRejectsAuthoritySwitch(t *testing.T) {
	g, _ := fixture(t, &fixtureBridge{}, http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Error("unexpected backend request") }))
	conn, reader, e := tunnel(t, g, "api.example.test")
	if e != nil {
		t.Fatal(e)
	}
	io.WriteString(conn, "GET / HTTP/1.1\r\nHost: 127.0.0.1:18080\r\n\r\n")
	response, e := http.ReadResponse(reader, &http.Request{Method: "GET"})
	if e == nil && response.StatusCode < 400 {
		t.Fatal("accepted authority switch")
	}
}

func TestHTTPServerSentEventFlushedBeforeCompletion(t *testing.T) {
	finish := make(chan struct{})
	g, _ := fixture(t, &fixtureBridge{}, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, "data: first\n\n")
		w.(http.Flusher).Flush()
		<-finish
	}))
	front := httptest.NewServer(g)
	defer front.Close()
	defer close(finish)
	u, _ := url.Parse(front.URL)
	client := &http.Client{Transport: &http.Transport{Proxy: http.ProxyURL(u)}, Timeout: 2 * time.Second}
	r, _ := http.NewRequest("GET", "http://api.example.test/events", nil)
	r.Header.Set("Proxy-Authorization", auth(g, "session-A"))
	response, e := client.Do(r)
	if e != nil {
		t.Fatal(e)
	}
	defer response.Body.Close()
	line, e := bufio.NewReader(response.Body).ReadString('\n')
	if e != nil || line != "data: first\n" {
		t.Fatalf("SSE did not flush: %q %v", line, e)
	}
}
func tlsBackend(t *testing.T, g **gateway, hits *atomic.Int32, capture ...func([]byte)) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "CONNECT" {
			t.Error("expected backend CONNECT")
			w.WriteHeader(400)
			return
		}
		raw, buf, e := w.(http.Hijacker).Hijack()
		if e != nil {
			return
		}
		defer raw.Close()
		buf.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n")
		buf.Flush()
		host, _, _ := net.SplitHostPort(r.Host)
		cert, e := (*g).certificate(host)
		if e != nil {
			t.Error(e)
			return
		}
		conn := tls.Server(raw, &tls.Config{Certificates: []tls.Certificate{cert}})
		if e = conn.Handshake(); e != nil {
			return
		}
		reader := bufio.NewReader(conn)
		for {
			inner, e := http.ReadRequest(reader)
			if e != nil {
				return
			}
			payload, _ := io.ReadAll(inner.Body)
			for _, fn := range capture {
				fn(payload)
			}
			inner.Body.Close()
			hits.Add(1)
			body := []byte("ok")
			encoding := ""
			if strings.Contains(inner.Header.Get("Accept-Encoding"), "gzip") { // like a real origin
				var z bytes.Buffer
				zw := gzip.NewWriter(&z)
				zw.Write(body)
				zw.Close()
				body, encoding = z.Bytes(), "Content-Encoding: gzip\r\n"
			}
			fmt.Fprintf(conn, "HTTP/1.1 200 OK\r\n%sContent-Length: %d\r\n\r\n%s", encoding, len(body), body)
			if inner.Close {
				return
			}
		}
	})
}

// The front must not negotiate gzip for a client that sent no Accept-Encoding:
// Go's transparent decompression drops Content-Length, and the tunnel then
// writes a body the client can never delimit (reqwest in the Codex CLI hung).
func TestTunnelKeepsUpstreamFramingForClientsWithoutAcceptEncoding(t *testing.T) {
	b := &fixtureBridge{request: func(context.Context, *pb.TransformRequestRequest) (*pb.TransformRequestResponse, error) {
		return &pb.TransformRequestResponse{Action: pb.TransformAction_TRANSFORM_ACTION_CONTINUE}, nil
	}}
	var g *gateway
	var hits atomic.Int32
	g, _ = fixture(t, b, tlsBackend(t, &g, &hits))
	conn, reader, e := tunnel(t, g, "api.example.test")
	if e != nil {
		t.Fatal(e)
	}
	conn.SetDeadline(time.Now().Add(3 * time.Second))
	io.WriteString(conn, "POST /mcp HTTP/1.1\r\nHost: api.example.test\r\nContent-Length: 0\r\n\r\n")
	response, e := http.ReadResponse(reader, &http.Request{Method: "POST"})
	if e != nil {
		t.Fatal(e)
	}
	if got, e := io.ReadAll(response.Body); e != nil || string(got) != "ok" {
		t.Fatalf("body %q %v", got, e)
	}
}

func TestRevocationCheckedForEveryRequestInSameTunnel(t *testing.T) {
	var live atomic.Bool
	live.Store(true)
	var hits atomic.Int32
	b := &fixtureBridge{request: func(context.Context, *pb.TransformRequestRequest) (*pb.TransformRequestResponse, error) {
		a := pb.TransformAction_TRANSFORM_ACTION_REJECT
		if live.Load() {
			a = pb.TransformAction_TRANSFORM_ACTION_CONTINUE
		}
		return &pb.TransformRequestResponse{Action: a}, nil
	}}
	var g *gateway
	g, _ = fixture(t, b, tlsBackend(t, &g, &hits))
	conn, reader, e := tunnel(t, g, "api.example.test")
	if e != nil {
		t.Fatal(e)
	}
	for i := 0; i < 2; i++ {
		io.WriteString(conn, "GET /resource HTTP/1.1\r\nHost: api.example.test\r\n\r\n")
		response, e := http.ReadResponse(reader, &http.Request{Method: "GET"})
		if e != nil {
			t.Fatal(e)
		}
		io.Copy(io.Discard, response.Body)
		response.Body.Close()
		want := 200
		if i == 1 {
			want = 403
		}
		if response.StatusCode != want {
			t.Fatalf("request%d status%d want%d", i, response.StatusCode, want)
		}
		live.Store(false)
	}
	if hits.Load() != 1 {
		t.Fatalf("revoked session reached backend: %d", hits.Load())
	}
}

type writeCounter int

func (c *writeCounter) Write(p []byte) (int, error) { *c++; return len(p), nil }

// tungstenite (the Codex CLI) allows ten reads for the handshake; per-header
// writes produced twenty TLS records through the tunnel.
func TestUpgradeHandshakeIsOneWrite(t *testing.T) {
	var writes writeCounter
	h := http.Header{"Upgrade": {"websocket"}, "Connection": {"Upgrade"}, "Sec-WebSocket-Accept": {"s3pPLMBiTxaQ9kYGzzhZRbK+xOo="}}
	if e := writeUpgradeResponse(&writes, h); e != nil || writes != 1 {
		t.Fatalf("handshake took %d writes (%v), want 1", writes, e)
	}
}

func TestWebsocketUpgradeIsGatedAndDuplex(t *testing.T) {
	for _, allow := range []bool{false, true} {
		t.Run(map[bool]string{false: "denied", true: "approved"}[allow], func(t *testing.T) {
			var hits atomic.Int32
			b := &fixtureBridge{request: func(context.Context, *pb.TransformRequestRequest) (*pb.TransformRequestResponse, error) {
				a := pb.TransformAction_TRANSFORM_ACTION_REJECT
				if allow {
					a = pb.TransformAction_TRANSFORM_ACTION_CONTINUE
				}
				return &pb.TransformRequestResponse{Action: a}, nil
			}}
			g, _ := fixture(t, b, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				hits.Add(1)
				if r.Header.Get("Upgrade") != "websocket" {
					t.Error("upgrade stripped")
				}
				c, buf, e := w.(http.Hijacker).Hijack()
				if e != nil {
					return
				}
				defer c.Close()
				buf.WriteString("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n")
				buf.Flush()
				io.Copy(c, buf)
			}))
			front := httptest.NewServer(g)
			defer front.Close()
			u, _ := url.Parse(front.URL)
			conn, e := net.Dial("tcp", u.Host)
			if e != nil {
				t.Fatal(e)
			}
			defer conn.Close()
			conn.SetDeadline(time.Now().Add(3 * time.Second))
			io.WriteString(conn, "GET http://api.example.test/socket HTTP/1.1\r\nHost: api.example.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nProxy-Authorization: "+auth(g, "session-A")+"\r\n\r\n")
			reader := bufio.NewReader(conn)
			resp, e := http.ReadResponse(reader, &http.Request{Method: "GET"})
			if e != nil {
				t.Fatal(e)
			}
			if !allow {
				if resp.StatusCode != 403 || hits.Load() != 0 {
					t.Fatalf("denied upgrade status%d hits%d", resp.StatusCode, hits.Load())
				}
				return
			}
			if resp.StatusCode != 101 {
				t.Fatalf("upgrade status%d", resp.StatusCode)
			}
			payload := []byte{0x81, 0x04, 'p', 'i', 'n', 'g'}
			if _, e = conn.Write(payload); e != nil {
				t.Fatal(e)
			}
			got := make([]byte, len(payload))
			if _, e = io.ReadFull(reader, got); e != nil {
				t.Fatal(e)
			}
			if !bytes.Equal(got, payload) {
				t.Error("duplex bytes changed")
			}
		})
	}
}

func TestLongHumanApprovalPreservesLargeTLSBody(t *testing.T) {
	var hits atomic.Int32
	payload := bytes.Repeat([]byte("large-upload-"), 8192)
	var received []byte
	b := &fixtureBridge{request: func(ctx context.Context, r *pb.TransformRequestRequest) (*pb.TransformRequestResponse, error) {
		if r.Request.Method != "CONNECT" {
			select {
			case <-time.After(31 * time.Second):
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		return &pb.TransformRequestResponse{Action: pb.TransformAction_TRANSFORM_ACTION_CONTINUE}, nil
	}}
	var g *gateway
	g, _ = fixture(t, b, tlsBackend(t, &g, &hits, func(body []byte) { received = body }))
	g.cfg.TimeoutMS = 40000
	conn, reader, e := tunnel(t, g, "api.example.test")
	if e != nil {
		t.Fatal(e)
	}
	conn.SetDeadline(time.Now().Add(40 * time.Second))
	r, _ := http.NewRequest("POST", "https://api.example.test/upload", bytes.NewReader(payload))
	if e = r.Write(conn); e != nil {
		t.Fatal(e)
	}
	resp, e := http.ReadResponse(reader, r)
	if e != nil {
		t.Fatal(e)
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || hits.Load() != 1 || !bytes.Equal(received, payload) {
		t.Fatalf("delayed body failed status=%d hits=%d bytes=%d want=%d", resp.StatusCode, hits.Load(), len(received), len(payload))
	}
}

func TestTLSBodyAndPipelinedRequestRemainSeparate(t *testing.T) {
	var hits atomic.Int32
	var g *gateway
	g, _ = fixture(t, &fixtureBridge{}, tlsBackend(t, &g, &hits))
	conn, reader, e := tunnel(t, g, "api.example.test")
	if e != nil {
		t.Fatal(e)
	}
	io.WriteString(conn, "POST /first HTTP/1.1\r\nHost: api.example.test\r\nContent-Length: 5\r\n\r\nhelloGET /second HTTP/1.1\r\nHost: api.example.test\r\n\r\n")
	for i := 0; i < 2; i++ {
		resp, e := http.ReadResponse(reader, &http.Request{Method: "GET"})
		if e != nil {
			t.Fatal(e)
		}
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		if resp.StatusCode != 200 {
			t.Fatalf("pipelined response%d status%d", i, resp.StatusCode)
		}
	}
	if hits.Load() != 2 {
		t.Fatalf("upstream count=%d", hits.Load())
	}
}
func TestTunnelOversizedHeaderRejectedBeforeBackend(t *testing.T) {
	g, _ := fixture(t, &fixtureBridge{}, http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Error("oversized request reached backend") }))
	conn, reader, e := tunnel(t, g, "api.example.test")
	if e != nil {
		t.Fatal(e)
	}
	io.WriteString(conn, "GET / HTTP/1.1\r\nHost: api.example.test\r\nX-Large: "+strings.Repeat("x", 66000)+"\r\n\r\n")
	resp, e := http.ReadResponse(reader, &http.Request{Method: "GET"})
	if e == nil && resp.StatusCode < 400 {
		t.Fatal("accepted oversized header")
	}
}

// Stock Iron relays a backend tunnel raw once it has seen an upgrade request,
// even when the origin answers 401 instead of 101. Pooling that connection
// sent every later request past Iron's credential injection (the Codex CLI
// saw unaudited 401s until the origin closed the tunnel minutes later).
func TestRejectedUpgradeConnectionIsNeverReused(t *testing.T) {
	var conns []string
	g, _ := fixture(t, &fixtureBridge{}, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conns = append(conns, r.RemoteAddr)
		if r.Header.Get("Upgrade") == "websocket" {
			w.Header().Set("Content-Length", "12")
			w.WriteHeader(401)
			io.WriteString(w, "unauthorized")
			return
		}
		io.WriteString(w, "ok")
	}))
	front := httptest.NewServer(g)
	defer front.Close()
	client := &http.Client{Transport: &http.Transport{Proxy: http.ProxyURL(mustURL(front.URL)), DisableKeepAlives: true}}
	for i, upgrade := range []bool{true, true, false} {
		r, _ := http.NewRequest("GET", "http://api.example.test/socket", nil)
		r.Header.Set("Proxy-Authorization", auth(g, "session-A"))
		if upgrade {
			r.Header.Set("Connection", "Upgrade")
			r.Header.Set("Upgrade", "websocket")
		}
		resp, e := client.Do(r)
		if e != nil {
			t.Fatal(e)
		}
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		want := 200
		if upgrade {
			want = 401
		}
		if resp.StatusCode != want {
			t.Fatalf("request%d status%d want%d", i, resp.StatusCode, want)
		}
	}
	if len(conns) != 3 {
		t.Fatalf("backend saw %d requests, want 3", len(conns))
	}
	for i := 1; i < len(conns); i++ {
		if conns[i] == conns[i-1] {
			t.Fatalf("request%d reused the backend connection of a rejected upgrade (%s)", i, conns[i])
		}
	}
}

func mustURL(raw string) *url.URL {
	u, e := url.Parse(raw)
	if e != nil {
		panic(e)
	}
	return u
}
