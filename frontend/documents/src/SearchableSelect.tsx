import { useId, useState } from "react";

type Option = { value: string; label: string; search?: string };

export function SearchableSelect({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  options: Option[];
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const filtered = options.filter((option) =>
    `${option.label} ${option.value} ${option.search || ""}`
      .toLocaleLowerCase()
      .includes(query.toLocaleLowerCase()),
  );
  const current = options.find((option) => option.value === value);
  const show = () => {
    setOpen(true);
    setQuery("");
    setActive(0);
  };
  const choose = (next: string) => {
    onChange(next);
    setOpen(false);
    setQuery("");
  };
  return (
    <div
      className="searchable-select"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <label htmlFor={id}>{label}</label>
      <div className="select-input">
        <input
          id={id}
          role="combobox"
          aria-expanded={open && !disabled}
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={
            open && filtered[active] ? `${id}-${active}` : undefined
          }
          autoComplete="off"
          disabled={disabled}
          value={open ? query : current?.label || ""}
          placeholder="Search by name or code…"
          onFocus={show}
          onClick={() => {
            if (!open) show();
          }}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
            setOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Escape") {
              event.preventDefault();
              setOpen(false);
            }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              if (!open) show();
              else
                setActive((index) =>
                  Math.max(
                    0,
                    Math.min(
                      filtered.length - 1,
                      index + (event.key === "ArrowDown" ? 1 : -1),
                    ),
                  ),
                );
            }
            if (event.key === "Enter") {
              event.preventDefault();
              if (!open) show();
              else if (filtered[active]) choose(filtered[active].value);
            }
          }}
        />
        <span aria-hidden="true">▾</span>
      </div>
      {open && !disabled && (
        <ul id={`${id}-list`} role="listbox" aria-label={label}>
          {filtered.map((option, index) => (
            <li
              id={`${id}-${index}`}
              key={option.value}
              role="option"
              aria-selected={option.value === value}
              className={index === active ? "active" : ""}
              ref={(node) => {
                if (index === active)
                  node?.scrollIntoView({ block: "nearest" });
              }}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(option.value)}
            >
              {option.label}
            </li>
          ))}
          {!filtered.length && <li role="presentation">No matching options</li>}
        </ul>
      )}
    </div>
  );
}
