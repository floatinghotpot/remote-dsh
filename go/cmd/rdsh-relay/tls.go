package main

import (
	"crypto/tls"
	"net/http"
	"net/url"
	"path/filepath"

	"golang.org/x/crypto/acme/autocert"
)

// startHTTPServer starts the node's HTTP(S) listener per R26/R27:
//   - behindProxy → plain HTTP (reverse proxy terminates TLS);
//   - tls.cert/key → manual cert (incl. wildcard), hot-reloaded per handshake;
//   - acme.enabled → Let's Encrypt via tls-alpn-01 (needs only 443).
func startHTTPServer(cfg *Config, handler http.Handler) error {
	if cfg.BehindProxy {
		return http.ListenAndServe(cfg.Listen, handler)
	}

	if cfg.TLS != nil {
		srv := &http.Server{
			Addr:    cfg.Listen,
			Handler: handler,
			// GetCertificate re-reads the cert/key on every handshake ⇒ manual
			// cert renewal needs no restart and drops no long-lived connection.
			TLSConfig: &tls.Config{
				GetCertificate: func(*tls.ClientHelloInfo) (*tls.Certificate, error) {
					cert, err := tls.LoadX509KeyPair(cfg.TLS.Cert, cfg.TLS.Key)
					return &cert, err
				},
			},
		}
		return srv.ListenAndServeTLS("", "")
	}

	if cfg.ACME != nil && cfg.ACME.Enabled {
		// Cache dir must persist (re-issue on every restart would hit LE limits).
		cacheDir := filepath.Join(cfg.DataDir, "acme")
		m := &autocert.Manager{
			Prompt:     autocert.AcceptTOS,
			Cache:      autocert.DirCache(cacheDir),
			HostPolicy: autocert.HostWhitelist(hostFromURL(cfg.AdvertiseURL)),
			Email:      cfg.ACME.Email,
		}
		srv := &http.Server{
			Addr:      cfg.Listen,
			Handler:   handler,
			TLSConfig: m.TLSConfig(),
		}
		return srv.ListenAndServeTLS("", "")
	}

	// Unreachable: validate() requires one of the three above.
	return http.ErrServerClosed
}

func hostFromURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	return u.Hostname()
}
