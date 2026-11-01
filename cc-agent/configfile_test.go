package main

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func statOwner(t *testing.T, path string) (os.FileMode, uint32, uint32) {
	t.Helper()
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat %s: %v", path, err)
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		t.Fatalf("stat %s: no Stat_t", path)
	}
	return fi.Mode().Perm(), st.Uid, st.Gid
}

func TestAtomicWriteFilePreservesModeAndOwner(t *testing.T) {
	for _, mode := range []os.FileMode{0640, 0600, 0644} {
		dir := t.TempDir()
		path := filepath.Join(dir, "config.json")
		if err := os.WriteFile(path, []byte("{}"), 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(path, mode); err != nil {
			t.Fatal(err)
		}
		_, wantUID, wantGID := statOwner(t, path)

		if err := atomicWriteFile(path, []byte(`{"a":1}`)); err != nil {
			t.Fatalf("atomicWriteFile: %v", err)
		}

		gotMode, gotUID, gotGID := statOwner(t, path)
		if gotMode != mode {
			t.Errorf("mode = %o, want %o", gotMode, mode)
		}
		if gotUID != wantUID || gotGID != wantGID {
			t.Errorf("owner = %d:%d, want %d:%d", gotUID, gotGID, wantUID, wantGID)
		}
		data, err := os.ReadFile(path)
		if err != nil || string(data) != `{"a":1}` {
			t.Errorf("content = %q, err = %v", data, err)
		}
	}
}

func TestAtomicWriteFileNewFileUsesDirGroup(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	_, _, dirGID := statOwner(t, dir)

	if err := atomicWriteFile(path, []byte("{}")); err != nil {
		t.Fatalf("atomicWriteFile: %v", err)
	}

	gotMode, _, gotGID := statOwner(t, path)
	if gotMode != 0640 {
		t.Errorf("mode = %o, want 640", gotMode)
	}
	if gotGID != dirGID {
		t.Errorf("gid = %d, want directory gid %d", gotGID, dirGID)
	}
}
