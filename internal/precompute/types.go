package precompute

const SchemaVersion = 1
const DiffAlgorithm = "myers-lines-runes-v1"

type Source struct {
	Digest string `json:"digest"`
	Length int    `json:"length"`
}
type Change struct {
	FromA int `json:"fromA"`
	ToA   int `json:"toA"`
	FromB int `json:"fromB"`
	ToB   int `json:"toB"`
}
type DiffResult struct {
	SchemaVersion int      `json:"schemaVersion"`
	Algorithm     string   `json:"algorithm"`
	Key           string   `json:"key"`
	Language      string   `json:"language"`
	Coordinate    string   `json:"coordinate"`
	Before        Source   `json:"before"`
	After         Source   `json:"after"`
	Precise       bool     `json:"precise"`
	Changes       []Change `json:"changes"`
}
type Point struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}
type PlanNode struct {
	ID       string `json:"id"`
	Kind     string `json:"kind"`
	Position Point  `json:"position"`
	Title    string `json:"title"`
	Summary  string `json:"summary"`
}
type PlanEdge struct {
	ID     string `json:"id"`
	Source string `json:"source"`
	Target string `json:"target"`
	Label  string `json:"label"`
}
type Graph struct {
	Nodes []PlanNode `json:"nodes"`
	Edges []PlanEdge `json:"edges"`
}
type Size struct {
	ID     string  `json:"id"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}
type LayoutInput struct {
	Nodes     []PlanNode `json:"nodes"`
	Edges     []PlanEdge `json:"edges"`
	Reference *Graph     `json:"reference,omitempty"`
	Sizes     []Size     `json:"sizes"`
}
type Port struct {
	ID     string  `json:"id"`
	Type   string  `json:"type"`
	Side   string  `json:"side"`
	Offset float64 `json:"offset"`
}
type LayoutNode struct {
	Position Point   `json:"position"`
	Width    float64 `json:"width"`
	Height   float64 `json:"height"`
	Ports    []Port  `json:"ports"`
}
type LayoutEdge struct {
	Points       []Point  `json:"points"`
	Label        Point    `json:"label"`
	SourceHandle string   `json:"sourceHandle"`
	TargetHandle string   `json:"targetHandle"`
	LabelWidth   *float64 `json:"labelWidth,omitempty"`
	LabelHeight  *float64 `json:"labelHeight,omitempty"`
	Kind         string   `json:"kind,omitempty"`
}
type LayoutResult struct {
	SchemaVersion         int                   `json:"schemaVersion"`
	Algorithm             string                `json:"algorithm"`
	Key                   string                `json:"key"`
	Nodes                 map[string]LayoutNode `json:"nodes"`
	Edges                 map[string]LayoutEdge `json:"edges"`
	UsesAuthoredPositions bool                  `json:"usesAuthoredPositions"`
}
