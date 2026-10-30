package main

import (
	"encoding/json"
	"testing"
)

func TestProjectsSaveListDelete(t *testing.T) {
	p := NewProjects(t.TempDir())
	id, err := p.Save([]byte(`{"name":"여름 여행","clips":[{"id":"c1"},{"id":"c2"}],"duration":12.5}`))
	if err != nil || !projectID.MatchString(id) {
		t.Fatalf("save: %v %q", err, id)
	}
	if _, err := p.Save([]byte(`{"id":"../../etc","name":"x"}`)); err == nil {
		t.Fatal("잘못된 id 를 받아들였어요")
	}
	l := p.List()
	if len(l) != 1 || l[0].Name != "여름 여행" || l[0].Clips != 2 || l[0].UpdatedAt == 0 {
		t.Fatalf("list: %+v", l)
	}
	b, err := p.Get(id)
	var m map[string]any
	if err != nil || json.Unmarshal(b, &m) != nil || m["id"] != id {
		t.Fatalf("get: %v %s", err, b)
	}
	if err := p.Delete(id); err != nil || len(p.List()) != 0 {
		t.Fatalf("delete: %v", err)
	}
}
