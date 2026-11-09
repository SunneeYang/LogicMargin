package precompute

type CodeRange struct {
	From int `json:"from"`
	To   int `json:"to"`
}
type Highlights struct {
	Before []CodeRange `json:"before"`
	After  []CodeRange `json:"after"`
}
type ScopePair struct {
	ID     string    `json:"id"`
	Kind   string    `json:"kind"`
	Name   string    `json:"name"`
	Before CodeRange `json:"before"`
	After  CodeRange `json:"after"`
}
type MovedCode struct {
	ScopePair
	Modified   bool       `json:"modified"`
	Highlights Highlights `json:"highlights"`
	Comparison DiffResult `json:"comparison"`
}
type ParsedSources struct {
	Before string `json:"before"`
	After  string `json:"after"`
}
type StructureResult struct {
	SchemaVersion  int            `json:"schemaVersion"`
	Algorithm      string         `json:"algorithm"`
	Key            string         `json:"key"`
	Language       string         `json:"language"`
	Coordinate     string         `json:"coordinate"`
	Before         Source         `json:"before"`
	After          Source         `json:"after"`
	Mode           string         `json:"mode"`
	Reason         string         `json:"reason,omitempty"`
	ParsedAs       *ParsedSources `json:"parsedAs,omitempty"`
	FormattingOnly bool           `json:"formattingOnly"`
	Highlights     Highlights     `json:"highlights"`
	Scopes         []ScopePair    `json:"scopes"`
	Moves          []MovedCode    `json:"moves"`
}
