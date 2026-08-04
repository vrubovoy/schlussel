// Moves keyboard focus to a field after it's marked invalid, so the visitor
// doesn't have to notice the new red border and manually click in - the red
// border alone leaves the caret wherever it happened to be (often nowhere).
export function focusField(id: string) {
  const el = document.getElementById(id)
  if (el instanceof HTMLElement) el.focus()
}

// Focuses whichever field is first, in visual/tab order, among those that
// just received an error - `fieldIds` must list every relevant key in that
// order (object key order is insertion order here, so callers control it).
export function focusFirstError<T extends object>(
  errors: T,
  fieldIds: Partial<Record<keyof T, string>>,
) {
  for (const key of Object.keys(fieldIds) as (keyof T)[]) {
    if (errors[key]) {
      focusField(fieldIds[key]!)
      return
    }
  }
}
