package update

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
)

type releaseTransport func(*http.Request) (*http.Response, error)

func (fn releaseTransport) RoundTrip(r *http.Request) (*http.Response, error) { return fn(r) }

func TestReleaseRateLimitFallback(t *testing.T) {
	for _, tc := range []struct {
		name, requested, destination, body, wantError string
		apiStatus, pageStatus                         int
	}{
		{name: "403", apiStatus: 403},
		{name: "429", apiStatus: 429},
		{name: "pinned", apiStatus: 403, requested: "1.0.1"},
		{name: "wrong pinned version", apiStatus: 403, requested: "1.0.2", wantError: "release_version_mismatch"},
		{name: "no fallback for missing release", apiStatus: 404, wantError: "release_http_404"},
		{name: "no fallback for server error", apiStatus: 500, wantError: "release_http_500"},
		{name: "website denied", apiStatus: 403, pageStatus: 403, wantError: "release_http_403"},
		{name: "draft", apiStatus: 403, body: `{"tag_name":"v1.0.1","draft":true}`, wantError: "invalid_release"},
		{name: "prerelease", apiStatus: 403, body: `{"tag_name":"v1.0.1","prerelease":true}`, wantError: "invalid_release"},
		{name: "invalid JSON", apiStatus: 403, body: `<html>unavailable</html>`, wantError: "invalid_release"},
		{name: "mismatched tag", apiStatus: 403, body: `{"tag_name":"v2.0.0"}`, wantError: "invalid_release"},
		{name: "another repository", apiStatus: 403, destination: "https://github.com/other/repository/releases/tag/v1.0.1", wantError: "invalid_release"},
		{name: "query string", apiStatus: 403, destination: repository + "/releases/tag/v1.0.1?untrusted=1", wantError: "invalid_release"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			client := releaseClient()
			calls := 0
			client.Transport = releaseTransport(func(r *http.Request) (*http.Response, error) {
				calls++
				status, body, header := 200, tc.body, make(http.Header)
				if body == "" {
					body = `{"tag_name":"v1.0.1","draft":false,"prerelease":false}`
				}
				switch {
				case r.URL.Host == "api.github.com":
					status, body = tc.apiStatus, `{"message":"API rate limit exceeded"}`
				case r.URL.String() == repository+"/releases/latest":
					if tc.pageStatus != 0 {
						status = tc.pageStatus
					} else {
						status = 302
						destination := tc.destination
						if destination == "" {
							destination = repository + "/releases/tag/v1.0.1"
						}
						header.Set("Location", destination)
					}
				}
				return &http.Response{StatusCode: status, Header: header, Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
			})
			value, err := check(context.Background(), client, "1.0.0", tc.requested)
			if tc.wantError != "" {
				if err == nil || err.Error() != tc.wantError {
					t.Fatalf("expected %s, got %+v, %v", tc.wantError, value, err)
				}
			} else if err != nil || value.Version != "1.0.1" || !value.Newer || value.URL != repository+"/releases/tag/v1.0.1" {
				t.Fatalf("rate-limited check failed: %+v, %v", value, err)
			}
			if tc.apiStatus != 403 && tc.apiStatus != 429 && calls != 1 {
				t.Fatalf("unexpected fallback for HTTP %d: %d requests", tc.apiStatus, calls)
			}
		})
	}
}
