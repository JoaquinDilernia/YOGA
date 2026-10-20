// El informe del agente viene en markdown simple: **negritas**, listas con "- " y párrafos
function inline(text) {
  return text
    .split(/(\*\*[^*]+\*\*)/g)
    .map((part, i) =>
      part.startsWith('**') && part.endsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : part,
    );
}

export default function Report({ text }) {
  const blocks = [];
  for (const line of text.split('\n')) {
    const item = line.match(/^\s*(?:[-*•]|\d+\.)\s+(.*)/);
    if (item) {
      const last = blocks.at(-1);
      if (last?.type === 'list') last.items.push(item[1]);
      else blocks.push({ type: 'list', items: [item[1]] });
    } else if (line.trim()) {
      blocks.push({ type: 'p', text: line.replace(/^#+\s*/, '') });
    }
  }
  return (
    <div className="report">
      {blocks.map((b, i) =>
        b.type === 'list' ? (
          <ul key={i}>
            {b.items.map((it, j) => (
              <li key={j}>{inline(it)}</li>
            ))}
          </ul>
        ) : (
          <p key={i}>{inline(b.text)}</p>
        ),
      )}
    </div>
  );
}
