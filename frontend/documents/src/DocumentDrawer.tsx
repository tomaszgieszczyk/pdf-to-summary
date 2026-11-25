import { useEffect, useRef, type ReactNode } from "react";

export function DocumentDrawer({
  filename,
  onDismiss,
  children,
}: {
  filename: string;
  onDismiss: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    const notifyShell = (open: boolean) => {
      if (window.parent !== window)
        window.parent.postMessage(
          { type: "document-drawer", open },
          location.origin,
        );
    };
    notifyShell(true);
    return () => {
      dialog.close();
      notifyShell(false);
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="preview-drawer"
      aria-labelledby="preview-heading"
      onCancel={(event) => {
        event.preventDefault();
        onDismiss();
      }}
      onClick={(event) => {
        if (event.target !== ref.current) return;
        const bounds = ref.current.getBoundingClientRect();
        if (
          event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom
        )
          onDismiss();
      }}
    >
      <header>
        <div>
          <h2 id="preview-heading">{filename}</h2>
        </div>
        <button
          className="secondary"
          onClick={onDismiss}
          autoFocus
          aria-label="Close document"
        >
          Close
        </button>
      </header>
      <div className="preview-content">{children}</div>
    </dialog>
  );
}
