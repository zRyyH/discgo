package auth

import "testing"

func TestUsername(t *testing.T) {
	for _, tc := range []struct{ email, username, key string }{
		{"joao.silva@gmail.com", "joao.silva", "joaosilva"},
		{"Joao.Silva@GMAIL.com", "joao.silva", "joaosilva"},
		{"ana@googlemail.com", "ana", "ana"},
		{"eva@empresa.com.br", "eva@empresa.com.br", "eva@empresa.com.br"},
	} {
		if u, k := Username(tc.email); u != tc.username || k != tc.key {
			t.Errorf("Username(%q) = %q, %q; want %q, %q", tc.email, u, k, tc.username, tc.key)
		}
	}
	for _, tc := range []struct{ input, key string }{
		{"joao.silva", "joaosilva"},
		{" JoaoSilva ", "joaosilva"},
		{"@joao.silva", "joaosilva"},
		{"joao.silva@gmail.com", "joaosilva"},
		{"Eva@Empresa.com.br", "eva@empresa.com.br"},
	} {
		if k := UsernameKey(tc.input); k != tc.key {
			t.Errorf("UsernameKey(%q) = %q, want %q", tc.input, k, tc.key)
		}
	}
}

func TestGooglePhoto(t *testing.T) {
	for in, want := range map[string]string{
		"https://lh3.googleusercontent.com/a/ACg8ocK=s96-c": "https://lh3.googleusercontent.com/a/ACg8ocK=s256-c",
		"https://lh3.googleusercontent.com/a/ACg8ocK":       "https://lh3.googleusercontent.com/a/ACg8ocK",
		"https://example.com/me=s96-c":                      "https://example.com/me=s96-c",
		"":                                                  "",
	} {
		if got := GooglePhoto(in); got != want {
			t.Errorf("GooglePhoto(%q) = %q, want %q", in, got, want)
		}
	}
}
