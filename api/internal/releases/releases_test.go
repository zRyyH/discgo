package releases

import "testing"

func TestOlder(t *testing.T) {
	for _, c := range []struct {
		client, latest string
		want           bool
	}{
		{"0.1.0", "0.1.1", true},
		{"0.1.9", "0.2.0", true},
		{"0.9.0", "1.0.0", true},
		{"0.1.10", "0.1.9", false},
		{"0.2.0", "0.2.0", false},
		{"v0.1.0", "0.1.1", true},
		{"0.1.0-beta", "0.1.0", false},
		{"test", "0.1.0", false},
		{"dev-browser", "9.9.9", false},
		{"0.1", "0.2.0", false},
		{"0.1.0", "", false},
	} {
		if got := Older(c.client, c.latest); got != c.want {
			t.Errorf("Older(%q, %q) = %v, want %v", c.client, c.latest, got, c.want)
		}
	}
}
