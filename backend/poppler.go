package main

import (
	"cmp"
	"context"
	"encoding/xml"
	"math"
	"slices"
	"strconv"
	"strings"
)

// Poppler reports coordinates in PDF points, measured from the top of the page.
type pdfWord struct {
	Left  float64 `xml:"xMin,attr"`
	Right float64 `xml:"xMax,attr"`
	Text  string  `xml:",chardata"`
}
type pdfLine struct {
	Left   float64   `xml:"xMin,attr"`
	Right  float64   `xml:"xMax,attr"`
	Top    float64   `xml:"yMin,attr"`
	Bottom float64   `xml:"yMax,attr"`
	Words  []pdfWord `xml:"word"`
}
type pdfTextPage struct {
	Width float64   `xml:"width,attr"`
	Lines []pdfLine `xml:"flow>block>line"`
}

func (l pdfLine) center() float64 { return (l.Top + l.Bottom) / 2 }
func (l pdfLine) text() string {
	words := make([]string, 0, len(l.Words))
	for _, word := range l.Words {
		words = append(words, strings.Join(strings.Fields(word.Text), " "))
	}
	return strings.Join(words, " ")
}

func readLocalPage(ctx context.Context, source string, n int) (text, margins string, err error) {
	num := strconv.Itoa(n)
	args := []string{"-f", num, "-l", num, "-enc", "UTF-8"}
	raw, err := pdfCommand(ctx, "pdftotext", 8<<20, append(args, "-bbox-layout", source, "-")...)
	if err == nil {
		var doc struct {
			Page pdfTextPage `xml:"body>doc>page"`
		}
		if err = xml.Unmarshal([]byte(raw), &doc); err == nil && doc.Page.Width > 0 {
			text, margins = doc.Page.readingText()
			if text != "" || len(doc.Page.Lines) == 0 {
				return text, margins, nil
			}
		}
	}
	// Pages consisting entirely of rotated writing, or without usable geometry,
	// can still be read using Poppler's own reading order.
	text, err = pdfCommand(ctx, "pdftotext", 1<<20, append(args, source, "-")...)
	return strings.TrimSpace(text), "", err
}
func (page pdfTextPage) readingText() (string, string) {
	var body []pdfLine
	var notes []string
	for _, line := range page.Lines {
		if len(line.Words) == 0 {
			continue
		}
		h, w := line.Bottom-line.Top, line.Right-line.Left
		if h > 3*w && h > 15 && (line.Right < page.Width*.09 || line.Left > page.Width*.91) {
			notes = append(notes, line.text())
			continue
		}
		body = append(body, line)
	}
	slices.SortStableFunc(body, func(a, b pdfLine) int { return cmp.Compare(a.center(), b.center()) })
	var text strings.Builder
	var previousBottom float64
	for len(body) > 0 {
		first := body[0]
		height := first.Bottom - first.Top
		end := 1
		for end < len(body) && body[end].center()-first.center() <= .42*min(height, body[end].Bottom-body[end].Top) {
			end++
		}
		row := body[:end]
		body = body[end:]
		slices.SortStableFunc(row, func(a, b pdfLine) int { return cmp.Compare(a.Left, b.Left) })
		if text.Len() > 0 {
			text.WriteByte('\n')
			if first.Top-previousBottom > math.Max(3, height*.52) {
				text.WriteByte('\n')
			}
		}
		previousBottom = first.Bottom
		for i, line := range row {
			previousBottom = max(previousBottom, line.Bottom)
			if i > 0 {
				text.WriteByte('\t')
			}
			for j, word := range line.Words {
				if j > 0 {
					if word.Left-line.Words[j-1].Right > 1.4*(line.Bottom-line.Top) {
						text.WriteByte('\t')
					} else {
						text.WriteByte(' ')
					}
				}
				text.WriteString(strings.Join(strings.Fields(word.Text), " "))
			}
		}
	}
	return strings.TrimSpace(text.String()), strings.Join(notes, "\n\n")
}
