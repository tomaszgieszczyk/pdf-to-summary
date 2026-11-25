package main

import "testing"

func TestReadingTextKeepsFormCellsTogetherAndSeparatesRotatedMargins(t *testing.T) {
	line := func(x, y float64, word string) pdfLine {
		return pdfLine{Left: x, Right: x + 18, Top: y, Bottom: y + 9, Words: []pdfWord{{Left: x, Right: x + 18, Text: word}}}
	}
	side := line(7, 0, "Margin")
	side.Right = 10
	side.Bottom = 120
	page := pdfTextPage{Width: 300, Lines: []pdfLine{
		line(168, 40, "Date"), line(28, 51, "Sample"), side, line(30, 40.8, "Name"), line(167, 51, "Today"), line(88, 15, "Title"),
	}}
	body, margin := page.readingText()
	if want := "Title\n\nName\tDate\nSample\tToday"; body != want || margin != "Margin" {
		t.Fatalf("body=%q notes=%q", body, margin)
	}
}
