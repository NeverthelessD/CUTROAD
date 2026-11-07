package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestCleanupPartLeftovers(t *testing.T) {
	d := t.TempDir()
	old := time.Now().Add(-2 * time.Hour)
	mk := func(n string, mt time.Time) string {
		p := filepath.Join(d, n)
		os.WriteFile(p, []byte("x"), 0o644)
		os.Chtimes(p, mt, mt)
		return p
	}
	gone := mk(".3728CD5E.cutroad-part.mp4.sb-8be95d61-ZR4che", old)
	fresh := mk(".97EEF486.cutroad-part.mp4.sb-8be95d61-PpbbfS", time.Now())
	keep1 := mk("여름 여행.mp4", old)
	keep2 := mk(".hidden.mp4.sb-1", old)
	cleanupPartLeftovers(d)
	if fileExists(gone) {
		t.Fatal("old leftover should be removed")
	}
	for _, p := range []string{fresh, keep1, keep2} {
		if !fileExists(p) {
			t.Fatalf("%s should stay", p)
		}
	}
}
