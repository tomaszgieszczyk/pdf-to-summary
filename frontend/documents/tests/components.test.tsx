import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { SearchableSelect } from "../src/SearchableSelect";
import App from "../src/App";

test("language dropdown searches codes and chooses by keyboard", () => {
  const change = vi.fn();
  render(
    <SearchableSelect
      label="Language"
      value="en"
      options={[
        { value: "en", label: "English" },
        { value: "pl", label: "Polish", search: "polski" },
      ]}
      onChange={change}
    />,
  );
  const input = screen.getByRole("combobox");
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: "polski" } });
  expect(screen.getAllByRole("option")).toHaveLength(1);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(change).toHaveBeenCalledWith("pl");
  expect(input.getAttribute("aria-expanded")).toBe("false");
});

test("IME Enter does not select a language while composing", () => {
  const change = vi.fn();
  render(
    <SearchableSelect
      label="Language"
      value="ja"
      options={[{ value: "ja", label: "Japanese" }]}
      onChange={change}
    />,
  );
  const input = screen.getByRole("combobox");
  fireEvent.focus(input);
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  expect(change).not.toHaveBeenCalled();
  expect(input.getAttribute("aria-expanded")).toBe("true");
  fireEvent.keyDown(input, { key: "Escape" });
  expect(input.getAttribute("aria-expanded")).toBe("false");
});

const document = {
  id: "a".repeat(32),
  filename: "example.pdf",
  state: "completed",
  terminal: true,
  size_bytes: 1234,
  page_count: 1,
  summary: "Saved original",
  summary_language: "en",
  summary_model: "test-model",
  summary_version_id: "g0",
  summary_version_revision: 0,
  summary_revision: 0,
  summary_edited_at: null,
  summary_versions: [
    {
      id: "g0",
      language: "en",
      model: "test-model",
      revision: 0,
      created_at: 1,
      edited_at: null,
    },
  ],
  progress: { extracted_pages: 1, prepared_pages: 1, summarized_pages: 1 },
  warnings: [],
  errors: [],
};

test("a rejected save keeps the draft and displays the conflict; summary view does not fetch pages", async () => {
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, options?: RequestInit) => {
      const path = String(input);
      let data: unknown = document;
      if (path.endsWith("/health"))
        data = {
          provider_configured: true,
          model: "test-model",
          max_upload_bytes: 100000,
          summary_languages: { en: "English", pl: "Polish" },
        };
      else if (path.includes("/documents?"))
        data = {
          items: [
            {
              ...document,
              size_bytes: "1234",
              page_count: "1",
              created_at: "1",
            },
          ],
          total: 1,
        };
      if (options?.method === "PATCH")
        return new Response(
          JSON.stringify({ detail: "Changed in another session" }),
          { status: 409 },
        );
      return new Response(JSON.stringify(data));
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  render(<App />);
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(await screen.findByRole("button", { name: /example.pdf/ }));
  await screen.findByRole("dialog", { name: "example.pdf" });
  fireEvent.click(await screen.findByRole("button", { name: "Edit summary" }));
  fireEvent.change(screen.getByLabelText("Edit summary (Markdown)"), {
    target: { value: "My unsaved work" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save summary" }));
  await screen.findByText("Changed in another session");
  expect(
    (screen.getByLabelText("Edit summary (Markdown)") as HTMLTextAreaElement)
      .value,
  ).toBe("My unsaved work");
  expect(
    fetchMock.mock.calls.some(([url]) => String(url).includes("/pages")),
  ).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(screen.queryByLabelText("Edit summary (Markdown)")).toBeNull(),
  );
  expect(screen.getByText("Saved original")).toBeTruthy();
});
