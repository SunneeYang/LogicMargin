package service

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"net/http"
	"regexp"
	"strconv"
	"strings"
)

const compressionThreshold = 1024

var qualityPattern = regexp.MustCompile(`^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$`)
var jsonSeparators = strings.NewReplacer(`\\`, `\\`, `\u2028`, "\u2028", `\u2029`, "\u2029")

func responseEncoding(header string, preferGzip bool) string {
	accepted := map[string]float64{}
	for item := range strings.SplitSeq(strings.ToLower(header), ",") {
		parts := strings.Split(strings.TrimSpace(item), ";")
		name := strings.TrimSpace(parts[0])
		if name == "" {
			continue
		}
		quality := 1.0
		for _, parameter := range parts[1:] {
			if parameter = strings.TrimSpace(parameter); strings.HasPrefix(parameter, "q=") {
				quality = 0
				if value := parameter[2:]; qualityPattern.MatchString(value) {
					quality, _ = strconv.ParseFloat(value, 64)
				}
				break
			}
		}
		accepted[name] = max(accepted[name], quality)
	}
	compressed, ok := accepted["gzip"]
	if !ok {
		compressed = accepted["*"]
	}
	identity, explicitIdentity := accepted["identity"]
	if !explicitIdentity {
		identity = 1
		if wildcard, present := accepted["*"]; present && wildcard == 0 {
			identity = 0
		}
	}
	if compressed > 0 && (identity == 0 || (preferGzip && !(explicitIdentity && identity > compressed))) {
		return "gzip"
	}
	if identity > 0 {
		return "identity"
	}
	if compressed > 0 {
		return "gzip"
	}
	return ""
}

func varyEncoding(header http.Header) {
	current := header.Get("Vary")
	for value := range strings.SplitSeq(current, ",") {
		if value = strings.TrimSpace(value); value == "*" || strings.EqualFold(value, "accept-encoding") {
			return
		}
	}
	if current != "" {
		current += ", "
	}
	header.Set("Vary", current+"Accept-Encoding")
}

func gzipBytes(body []byte) ([]byte, error) {
	var buffer bytes.Buffer
	writer := gzip.NewWriter(&buffer)
	if _, err := writer.Write(body); err != nil {
		return nil, err
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	return buffer.Bytes(), nil
}

func jsonBytes(value any) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return []byte(jsonSeparators.Replace(strings.TrimSuffix(buffer.String(), "\n"))), nil
}

func sendJSON(w http.ResponseWriter, r *http.Request, status int, value any) {
	if r.Context().Err() != nil {
		return
	}
	body, err := jsonBytes(value)
	if err != nil {
		status, body = 500, []byte(`{"error":"响应序列化失败"}`)
	}
	encoding := responseEncoding(r.Header.Get("Accept-Encoding"), len(body) >= compressionThreshold)
	if encoding == "" {
		status, body = 406, nil
	} else if encoding == "gzip" {
		compressed, err := gzipBytes(body)
		if err == nil {
			body = compressed
		} else if responseEncoding(r.Header.Get("Accept-Encoding"), false) == "identity" {
			encoding = "identity"
		} else {
			status, body, encoding = 500, nil, ""
		}
	}
	varyEncoding(w.Header())
	if encoding == "gzip" {
		w.Header().Set("Content-Encoding", "gzip")
	} else {
		w.Header().Del("Content-Encoding")
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	if r.Method != http.MethodHead {
		_, _ = w.Write(body)
	}
}
