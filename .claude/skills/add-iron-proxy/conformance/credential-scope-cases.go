//go:build ignore

// Records Iron's own rule matching for credential-scope-cases.json, so the
// approval adapter's test can prove its reading is never narrower than Iron's.
// Run inside an iron-proxy checkout at versions.json's iron-proxy-commit:
//
//	mkdir -p cmd/scope-cases && cp credential-scope-cases.go cmd/scope-cases/
//	IRON_PROXY_COMMIT=$(git rev-parse HEAD) go run cmd/scope-cases/credential-scope-cases.go > credential-scope-cases.json
package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"

	"github.com/ironsh/iron-proxy/internal/hostmatch"
)

type rule struct {
	Host    string   `json:"host,omitempty"`
	CIDR    string   `json:"cidr,omitempty"`
	Methods []string `json:"methods,omitempty"`
	Paths   []string `json:"paths,omitempty"`
}

type request struct {
	Host   string `json:"host"`
	Method string `json:"method"`
	Path   string `json:"path"`
}

func main() {
	commit := os.Getenv("IRON_PROXY_COMMIT")
	if commit == "" {
		panic("IRON_PROXY_COMMIT is required")
	}
	hosts := []string{"api.example.com", "API.Example.COM", "*.example.com", "*", "api.*", "*example.com", "a?i.example.com", "[ab]pi.example.com", "*.", "*.*.com", "example.com", "api.example.com."}
	cidrs := []string{"10.0.0.0/8", "0.0.0.0/0"}
	methods := [][]string{nil, {"*"}, {"GET"}, {"get"}, {"POST"}, {"HEAD", "POST"}, {"POST", "*"}}
	paths := [][]string{nil, {"/repos/*"}}
	var rules []rule
	for _, m := range methods {
		for _, p := range paths {
			for _, h := range hosts {
				rules = append(rules, rule{Host: h, Methods: m, Paths: p})
			}
			for _, c := range cidrs {
				rules = append(rules, rule{CIDR: c, Methods: m, Paths: p})
			}
		}
	}
	var requests []request
	for _, h := range []string{"api.example.com", "API.EXAMPLE.COM", "example.com", "deep.api.example.com", "xexample.com", "api.example.org", "api.example.com:8443", "apixexample.com", "evil.test", "10.1.2.3", "[::1]:443"} {
		for _, m := range []string{"GET", "HEAD", "POST"} {
			for _, p := range []string{"/", "/repos/x"} {
				requests = append(requests, request{h, m, p})
			}
		}
	}
	matrix := make([]string, len(rules))
	for i, r := range rules {
		compiled, err := hostmatch.CompileRules([]hostmatch.RuleConfig{{Host: r.Host, CIDR: r.CIDR, Methods: r.Methods, Paths: r.Paths}}, "case")
		row := make([]byte, len(requests))
		for j, q := range requests {
			row[j] = '0'
			if err == nil && hostmatch.MatchAnyRule(compiled, &http.Request{Host: q.Host, Method: q.Method, URL: &url.URL{Path: q.Path}}) {
				row[j] = '1'
			}
		}
		matrix[i] = string(row)
	}
	fmt.Printf("{\n  \"ironProxyCommit\": %q,\n", commit)
	list("rules", rules, ",")
	list("requests", requests, ",")
	list("matches", matrix, "")
	fmt.Println("}")
}

// list prints one JSON value per line so a regenerated table diffs by case.
func list[T any](name string, items []T, after string) {
	fmt.Printf("  %q: [\n", name)
	for i, item := range items {
		line, err := json.Marshal(item)
		if err != nil {
			panic(err)
		}
		sep := ","
		if i == len(items)-1 {
			sep = ""
		}
		fmt.Printf("    %s%s\n", line, sep)
	}
	fmt.Printf("  ]%s\n", after)
}
