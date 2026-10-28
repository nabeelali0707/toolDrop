// Names for tool fields and inputs, made from what a page shows. Browser-safe,
// so the Chrome extension suggests the same input names as `tooldrop record`.

/** A name usable in templates: letters, digits and _. */
export function identifier(text: string): string {
  const name = text
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (name === '') return 'value';
  return /^\d/.test(name) ? `f_${name}` : name;
}

/** The input name to suggest for a recorded field, from its label: `textbox "Issue date"` gives issue_date. */
export function suggestedInputName(label: string): string {
  return identifier(/"([^"]+)"/.exec(label)?.[1] ?? label);
}
