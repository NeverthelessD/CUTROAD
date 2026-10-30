package main

// 프로젝트 저장소: Support/projects/<id>.json 한 파일에 프로젝트 하나.
// 화면이 편집할 때마다(자동 저장) 통째로 보내요. 영상 파일 자체는 복사하지 않고 원래 위치(경로)만 적어 둬요.

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"sync"
	"time"
)

type Projects struct {
	mu  sync.Mutex
	dir string
}

type ProjectSummary struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	Mode      string  `json:"mode"`
	Duration  float64 `json:"duration"`
	Clips     int     `json:"clipCount"`
	Thumb     string  `json:"thumb"`
	UpdatedAt int64   `json:"updatedAt"`
}

var projectID = regexp.MustCompile(`^[a-z0-9]{6,40}$`)

func NewProjects(dir string) *Projects {
	os.MkdirAll(dir, 0o755)
	return &Projects{dir: dir}
}

func (p *Projects) path(id string) string { return filepath.Join(p.dir, id+".json") }

func (p *Projects) Count() int {
	m, _ := filepath.Glob(filepath.Join(p.dir, "*.json"))
	return len(m)
}

func (p *Projects) List() []ProjectSummary {
	p.mu.Lock()
	defer p.mu.Unlock()
	files, _ := filepath.Glob(filepath.Join(p.dir, "*.json"))
	out := []ProjectSummary{}
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			continue
		}
		var s ProjectSummary
		var raw struct {
			Clips []json.RawMessage `json:"clips"`
		}
		if json.Unmarshal(b, &s) != nil || !projectID.MatchString(s.ID) {
			continue
		}
		json.Unmarshal(b, &raw)
		s.Clips = len(raw.Clips)
		out = append(out, s)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].UpdatedAt > out[j].UpdatedAt })
	return out
}

func (p *Projects) Get(id string) ([]byte, error) {
	if !projectID.MatchString(id) {
		return nil, errors.New("잘못된 프로젝트예요")
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	return os.ReadFile(p.path(id))
}

// Save stores the whole project. It keeps the id, stamps updatedAt and returns the id.
func (p *Projects) Save(b []byte) (string, error) {
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		return "", errors.New("프로젝트 내용을 읽지 못했어요")
	}
	id, _ := m["id"].(string)
	if id == "" {
		id = randID(8)
		m["id"] = id
	}
	if !projectID.MatchString(id) {
		return "", errors.New("잘못된 프로젝트예요")
	}
	if name, _ := m["name"].(string); name == "" {
		m["name"] = "새 프로젝트"
	}
	m["updatedAt"] = time.Now().UnixMilli()
	out, err := json.Marshal(m)
	if err != nil {
		return "", err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	tmp := p.path(id) + ".tmp"
	if err := os.WriteFile(tmp, out, 0o644); err != nil {
		return "", errors.New("프로젝트를 저장하지 못했어요")
	}
	if err := os.Rename(tmp, p.path(id)); err != nil {
		return "", errors.New("프로젝트를 저장하지 못했어요")
	}
	return id, nil
}

// Delete moves the project file to the trash folder (Support/projects/.trash) instead of removing it.
func (p *Projects) Delete(id string) error {
	if !projectID.MatchString(id) {
		return errors.New("잘못된 프로젝트예요")
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	trash := filepath.Join(p.dir, ".trash")
	os.MkdirAll(trash, 0o755)
	return os.Rename(p.path(id), filepath.Join(trash, id+".json"))
}
