/* Kanban — merged-all board with optional group-by-space rows.
 *
 * No per-space dropdown anymore — the board always shows every space merged.
 * A toggle flips between two body layouts:
 *   • flat   — classic 5-column kanban, cards stacked in each column.
 *   • rowed  — one horizontal band per space, each with its own 5-column
 *              slice, rules between bands.
 *
 * Data comes from kanban/backend.js via HTTP. Live updates ride the shell's
 * shared WebSocket (topic `kanban`). Writes go through the same API
 * (see .claude/skills/atelier-kanban/SKILL.md).
 */

const { useState, useEffect, useRef } = React;

const COLS = [
  { id: 'todo',    label: 'todo',        tone: '#83a598' },
  { id: 'doing',   label: 'in progress', tone: '#d79921' },
  { id: 'needs',   label: 'needs input', tone: '#fb4934' },
  { id: 'done',    label: 'done',        tone: '#8ec07c' },
  { id: 'archive', label: 'archive',     tone: 'var(--color-fg-subtle)' },
];
const COL_GRID = { gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', gap: '10px' };

const TAG_DOT = {
  amber: '#d79921', aqua: '#689d6a', blue: '#458588',
  purple: '#b16286', red: '#cc241d', green: '#98971a', orange: '#d65d0e',
};
const TAG_KEYS = Object.keys(TAG_DOT);

function tagColor(label) {
  let h = 0;
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) & 0xffffffff;
  return TAG_KEYS[Math.abs(h) % TAG_KEYS.length];
}

function relTime(iso) {
  if (!iso) return '';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 10) return 'now';
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
}

const fetchCards = (name) =>
  fetch(`/api/kanban/spaces/${name}/cards`, { headers: { Accept: 'application/json' }})
    .then((r) => r.json())
    .then(({ cards }) => cards);

/* ============================================================================
 * ATOMS
 * ========================================================================== */

/* Tiny pragmatic markdown renderer — headings, lists, code blocks, inline
 * code, bold/italic, links. Good enough for kanban notes; not a full spec.
 * Intentionally inline to avoid a dep. */
function parseBlocks(src) {
  const lines = (src || '').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('```')) {
      i++;
      const code = [];
      while (i < lines.length && !lines[i].startsWith('```')) { code.push(lines[i]); i++; }
      i++;
      blocks.push({ type: 'code', content: code.join('\n') });
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { blocks.push({ type: 'h', level: h[1].length, content: h[2] }); i++; continue; }
    if (/^[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) { items.push(lines[i].replace(/^[-*]\s+/, '')); i++; }
      blocks.push({ type: 'ul', items });
      continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) { items.push(lines[i].replace(/^\d+\.\s+/, '')); i++; }
      blocks.push({ type: 'ol', items });
      continue;
    }
    if (line.trim() === '') { i++; continue; }
    const para = [];
    while (i < lines.length && lines[i].trim() !== '' && !/^(#{1,6}\s|[-*]\s|\d+\.\s|```)/.test(lines[i])) {
      para.push(lines[i]); i++;
    }
    blocks.push({ type: 'p', content: para.join(' ') });
  }
  return blocks;
}

function renderInline(text) {
  const patterns = [
    { re: /`([^`]+)`/,                   render: (m, k) => <code key={k} className="font-mono text-[11.5px] bg-sunken px-1 py-[1px] rounded-xs text-fg-secondary">{m[1]}</code> },
    { re: /\[([^\]]+)\]\(([^)]+)\)/,     render: (m, k) => <a key={k} href={m[2]} target="_blank" rel="noreferrer" className="text-accent-primary-hi underline">{m[1]}</a> },
    { re: /\*\*([^*]+)\*\*/,             render: (m, k) => <strong key={k} className="font-semibold text-fg-display">{m[1]}</strong> },
    { re: /(?<![*])\*([^*]+)\*(?![*])/,  render: (m, k) => <em key={k}>{m[1]}</em> },
  ];
  const nodes = [];
  let rest = text;
  let k = 0;
  while (rest.length > 0) {
    let hit = null;
    for (const p of patterns) {
      const m = rest.match(p.re);
      if (m && (!hit || m.index < hit.m.index)) hit = { p, m };
    }
    if (!hit) { nodes.push(rest); break; }
    if (hit.m.index > 0) nodes.push(rest.slice(0, hit.m.index));
    nodes.push(hit.p.render(hit.m, k++));
    rest = rest.slice(hit.m.index + hit.m[0].length);
  }
  return nodes;
}

function Markdown({ src }) {
  const blocks = parseBlocks(src);
  return (
    <div className="font-sans text-13 text-fg-primary leading-[1.55] flex flex-col gap-2.5">
      {blocks.map((b, i) => {
        if (b.type === 'h') {
          const sizeCls =
            b.level === 1 ? 'text-[15px] font-semibold mt-2'  :
            b.level === 2 ? 'text-[13.5px] font-semibold mt-1.5' :
                            'text-[12.5px] font-semibold';
          return <div key={i} className={`text-fg-display ${sizeCls}`}>{renderInline(b.content)}</div>;
        }
        if (b.type === 'code') {
          return (
            <pre key={i} className="font-mono text-11 bg-sunken border border-default rounded-sm px-3 py-2 overflow-x-auto whitespace-pre text-fg-secondary shadow-inset-well">
              {b.content}
            </pre>
          );
        }
        if (b.type === 'ul') {
          return (
            <ul key={i} className="list-disc pl-5 flex flex-col gap-1 marker:text-fg-muted">
              {b.items.map((it, j) => <li key={j}>{renderInline(it)}</li>)}
            </ul>
          );
        }
        if (b.type === 'ol') {
          return (
            <ol key={i} className="list-decimal pl-5 flex flex-col gap-1 marker:text-fg-muted">
              {b.items.map((it, j) => <li key={j}>{renderInline(it)}</li>)}
            </ol>
          );
        }
        return <p key={i} className="m-0">{renderInline(b.content)}</p>;
      })}
    </div>
  );
}

function Tag({ label, active, dim, onClick, size = 'md' }) {
  const dot = TAG_DOT[tagColor(label)];
  const sm = size === 'sm';
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick && onClick(label); }}
      className={[
        'relative font-mono rounded-xs whitespace-nowrap cursor-pointer border',
        'transition-all duration-[140ms] ease-enter',
        sm
          ? 'text-[9px] pl-2 pr-1 py-0'
          : 'text-[10px] pl-3 pr-1.5 py-[1px]',
        active
          ? 'text-fg-display bg-accent-primary-wash border-[rgba(215,153,33,0.55)]'
          : 'text-fg-secondary bg-card border-default',
      ].join(' ')}
      style={{ opacity: dim ? 0.35 : 1 }}
    >
      <span
        className={[
          'absolute top-1/2 -translate-y-1/2 rounded-full',
          sm ? 'left-[3px] w-[3px] h-[3px]' : 'left-[4.5px] w-1 h-1',
        ].join(' ')}
        style={{ background: dot }}
      />
      {label}
    </button>
  );
}

/* Space chip — bordered pill; never hash-colored. Used on cards + in the
 * detail drawer + as the header label for rowed-mode space bands. */
function SpaceChip({ name }) {
  return (
    <span className="inline-flex items-center gap-1 font-mono text-[10px] rounded-xs px-1.5 py-[1px] border border-strong bg-transparent text-fg-secondary whitespace-nowrap">
      <span className="text-fg-muted">§</span>{name}
    </span>
  );
}

/* ============================================================================
 * CARD
 * ========================================================================== */

function Card({ card, activeTag, onTag, onOpen, dim, selected, showSpace = true }) {
  return (
    <div
      data-kanban-card
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', card.id);
      }}
      onClick={() => onOpen(card)}
      className={[
        'bg-card border rounded-sm pt-[9px] px-2.5 pb-2 mb-1.5',
        'flex flex-col gap-1.5 cursor-pointer',
        'transition-all duration-[140ms] ease-enter',
        selected
          ? 'border-[rgba(215,153,33,0.55)] border-l-2 border-l-accent-primary'
          : 'border-default',
      ].join(' ')}
      style={{ opacity: dim ? 0.35 : 1 }}
    >
      {/* id + progress% */}
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-[10px] text-fg-muted whitespace-nowrap">{card.id}</span>
        <span className="flex-1" />
        {card.progress != null && (
          <span className="font-mono text-[10px] text-accent-primary-hi">
            {Math.round(card.progress)}%
          </span>
        )}
      </div>

      {/* title */}
      <div className="font-sans text-13 leading-[1.38] text-fg-primary [text-wrap:pretty]">
        {card.title}
      </div>

      {card.question && (
        <div
          className="font-sans text-[11.5px] italic text-fg-secondary leading-[1.4] pl-2"
          style={{ borderLeft: '2px solid rgba(251,73,52,0.55)' }}
        >
          {card.question}
        </div>
      )}

      {card.progress != null && (
        <div className="h-[2px] bg-sunken rounded-[1px] overflow-hidden">
          <div
            className="h-full bg-accent-primary"
            style={{ width: card.progress + '%' }}
          />
        </div>
      )}

      {/* tags */}
      <div className="flex flex-wrap gap-1 items-center">
        {(card.tags || []).map((tag) => (
          <Tag key={tag} label={tag} active={tag === activeTag} onClick={onTag} size="sm" />
        ))}
      </div>

      {/* meta row — space chip is hidden in rowed mode (the band header
       * already labels the space; no need to repeat on every card). */}
      <div className="flex items-center gap-1.5 font-mono text-[10px] text-fg-muted flex-wrap">
        {showSpace && card.space && <SpaceChip name={card.space} />}
        <span><span className="text-accent-secondary-hi">@</span>{card.agent || 'unassigned'}</span>
        <span className="text-fg-subtle">·</span>
        <span>{relTime(card.updated_at)}</span>
      </div>
    </div>
  );
}

/* ============================================================================
 * CELL — a card list for one column × (optionally) one space.
 * ========================================================================== */

function Cell({ cards, activeTag, onTag, onOpen, selectedId, showSpace, dropCol, dropSpace, onMoveCard }) {
  const [over, setOver] = useState(false);
  const dropHandlers = {
    onDragOver: (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (!over) setOver(true); },
    onDragLeave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(false); },
    onDrop: (e) => {
      e.preventDefault();
      setOver(false);
      const id = e.dataTransfer.getData('text/plain');
      if (id && onMoveCard) onMoveCard(id, { col: dropCol, space: dropSpace });
    },
  };
  if (cards.length === 0) {
    return (
      <div
        {...dropHandlers}
        className={[
          'font-mono text-11 px-2.5 py-3 rounded-sm border border-dashed transition-colors duration-fast',
          over
            ? 'border-[rgba(215,153,33,0.55)] bg-accent-primary-wash text-accent-primary-hi'
            : 'border-subtle text-fg-subtle',
        ].join(' ')}
      >
        {over ? 'drop here.' : 'nothing on the bench.'}
      </div>
    );
  }
  return (
    <div
      {...dropHandlers}
      className={[
        'rounded-sm transition-colors duration-fast',
        over ? 'bg-accent-primary-wash ring-1 ring-[rgba(215,153,33,0.45)]' : '',
      ].join(' ')}
    >
      {cards.map((c) => (
        <Card
          key={c.id}
          card={c}
          activeTag={activeTag}
          onTag={onTag}
          onOpen={onOpen}
          selected={selectedId === c.id}
          dim={activeTag && !(c.tags || []).includes(activeTag)}
          showSpace={showSpace}
        />
      ))}
    </div>
  );
}

function Detail({ card, onClose, onTag, activeTag }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!card) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    // Close when a pointerdown lands outside the drawer and outside any card
    // (so clicking another card still switches instead of just closing).
    const onDown = (e) => {
      const node = ref.current;
      if (!node || node.contains(e.target)) return;
      if (e.target.closest?.('[data-kanban-card]')) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown);
    };
  }, [card, onClose]);
  if (!card) return null;
  const col = COLS.find((c) => c.id === card.col);
  return (
    <aside
      ref={ref}
      className={[
        'w-[480px] flex flex-col overflow-hidden bg-raised border-l border-default',
        // Below 1400px: overlay the board, don't squeeze it.
        // At 1400px+: static flow, pushes the board as before.
        'absolute top-0 right-0 bottom-0 z-10 shadow-dock',
        'min-[1400px]:static min-[1400px]:flex-none min-[1400px]:z-auto min-[1400px]:shadow-none',
      ].join(' ')}
      style={{ animation: 'mod-enter 240ms var(--ease-enter) both' }}
    >
      <div className="flex-none h-10 flex items-center gap-2 px-3 border-b border-subtle">
        <span className="font-mono text-11 text-accent-primary-hi">{card.id}</span>
        <span className="font-mono text-11 text-fg-muted">·</span>
        <span className="font-mono text-11 text-fg-muted">{col.label}</span>
        <span className="flex-1" />
        <SpaceChip name={card.space} />
        <button
          onClick={onClose}
          className="w-6 h-6 inline-flex items-center justify-center bg-transparent border border-transparent text-fg-muted rounded-sm cursor-pointer hover:bg-card ml-1"
        >
          <i data-lucide="x" className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="flex-1 overflow-x-hidden overflow-y-auto px-[18px] py-4 flex flex-col gap-3.5">
        <h3 className="font-sans text-[18px] font-semibold text-fg-display leading-[1.28] m-0 [text-wrap:pretty]">
          {card.title}
        </h3>

        <div
          className="grid gap-x-3.5 gap-y-[5px] font-mono text-11"
          style={{ gridTemplateColumns: 'auto 1fr' }}
        >
          <span className="text-fg-muted">agent</span>
          <span className="text-fg-primary"><span className="text-accent-secondary-hi">@</span>{card.agent || 'unassigned'}</span>
          <span className="text-fg-muted">touched</span>
          <span className="text-fg-primary">{relTime(card.updated_at)}</span>
          {card.progress != null && (
            <>
              <span className="text-fg-muted">progress</span>
              <span className="text-accent-primary-hi">{Math.round(card.progress)}%</span>
            </>
          )}
        </div>

        <div className="flex flex-wrap gap-1">
          {(card.tags || []).map((tag) => (
            <Tag key={tag} label={tag} active={tag === activeTag} onClick={onTag} />
          ))}
        </div>

        {card.question && (
          <div
            className="font-sans text-13 italic text-fg-secondary leading-[1.5] pl-2.5"
            style={{ borderLeft: '2px solid rgba(251,73,52,0.55)' }}
          >
            {card.question}
          </div>
        )}

        <div className="bg-sunken border border-default rounded-sm px-3.5 py-3 shadow-inset-well">
          {card.notes
            ? <Markdown src={card.notes} />
            : <div className="font-mono text-12 leading-[1.6] text-fg-muted whitespace-pre-wrap">
                {`opened by @${card.agent || 'unassigned'}.\n\nscratch notes go here. agents can write here too.`}
                <span className="cursor" />
              </div>
          }
        </div>
      </div>
    </aside>
  );
}

/* ============================================================================
 * MODULE
 * ========================================================================== */

export default function Module() {
  const [spaces,   setSpaces]   = useState([]);
  const [cards,    setCards]    = useState([]);
  const [rowed,    setRowed]    = useState(false);     // user intent
  const [displayed, setDisplayed] = useState(false);   // what's actually rendered
  const [fading,   setFading]   = useState(false);     // true during the out → in swap
  const [activeTag, setActiveTag] = useState(null);
  const [openCard, setOpenCard] = useState(null);
  const onTag = (t) => setActiveTag((cur) => (cur === t ? null : t));

  // Drag a card to a new column (and, in rowed mode, possibly a new space).
  // Optimistic local patch + POST through the same markdown route agents use.
  // On failure we revert — fetch only rejects on network errors, so check
  // r.ok too. The shell-WS broadcast reconciles any drift on the next mutation either way.
  const moveCard = (id, { col, space }) => {
    const card = cards.find((c) => c.id === id);
    if (!card) return;
    const targetSpace = space || card.space;
    if (card.col === col && card.space === targetSpace) return;
    const prev = { col: card.col, space: card.space };
    setCards((curr) => curr.map((c) => (c.id === id ? { ...c, col, space: targetSpace } : c)));
    fetch(`/api/kanban/spaces/${targetSpace}/cards`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/markdown' },
      body: `---\nid: ${id}\ncol: ${col}\n---\n`,
    })
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); })
      .catch((err) => {
        console.error('[kanban] move failed, reverting:', err);
        setCards((curr) => curr.map((c) => (c.id === id ? { ...c, ...prev } : c)));
      });
  };

  // Toggle animation: when the user flips the button, fade the whole body
  // out + slide up, swap the tree while invisible, then fade back in. Inside
  // the wrapper, rowed-mode bands still stagger their own mod-enter — the
  // two animations layer cleanly because opacity is multiplicative.
  useEffect(() => {
    if (rowed === displayed) return;
    setFading(true);
    const t = setTimeout(() => {
      setDisplayed(rowed);
      setFading(false);
    }, 180);
    return () => clearTimeout(t);
  }, [rowed, displayed]);

  // Load the list of spaces on mount.
  useEffect(() => {
    fetch('/api/kanban/spaces', { headers: { Accept: 'application/json' }})
      .then((r) => r.json())
      .then(({ spaces }) => setSpaces(spaces))
      .catch((err) => console.error('[kanban] spaces fetch failed:', err));
  }, []);

  // Fan out per space and merge. No server-side aggregation keeps the
  // agent-facing API firehose-free.
  useEffect(() => {
    if (spaces.length === 0) { setCards([]); return; }
    Promise.all(spaces.map((s) => fetchCards(s.name)))
      .then((lists) => setCards(lists.flat()))
      .catch((err) => console.error('[kanban] cards fetch failed:', err));
  }, [spaces]);

  // Live updates. The shell multiplexes a single WebSocket per tab; we
  // subscribe to the 'kanban' topic and refetch the changed space.
  useEffect(() => {
    if (!window.__atelier?.subscribe) return;
    return window.__atelier.subscribe('kanban', (frame) => {
      if (frame.type === 'spaces-changed') {
        fetch('/api/kanban/spaces', { headers: { Accept: 'application/json' }})
          .then((r) => r.json())
          .then(({ spaces }) => setSpaces(spaces))
          .catch(() => {});
      } else if (frame.type === 'cards-changed') {
        fetchCards(frame.space)
          .then((updated) => setCards((prev) => [
            ...prev.filter((c) => c.space !== frame.space),
            ...updated,
          ]))
          .catch(() => {});
      }
    });
  }, []);

  // Column totals — shown in the global column header row.
  const colCounts = Object.fromEntries(COLS.map((c) => [c.id, 0]));
  for (const c of cards) if (colCounts[c.col] != null) colCounts[c.col] += 1;

  // Spaces to render as rows. Sort by name for stable layout.
  const rowedSpaces = displayed
    ? [...spaces].sort((a, b) => a.name.localeCompare(b.name))
    : null;

  return (
    <div className="flex-1 flex overflow-hidden min-h-0 bg-canvas relative">
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">

        {/* Board header */}
        <div className="flex-none flex items-center gap-2.5 px-3.5 py-2.5 border-b border-subtle whitespace-nowrap">
          <i data-lucide="kanban-square" className="w-3.5 h-3.5 text-fg-secondary" />
          <button
            onClick={() => setRowed((r) => !r)}
            title={rowed ? 'ungroup — back to flat columns' : 'group by space — one row per space'}
            className={[
              'inline-flex items-center gap-1.5 rounded-xs px-2 py-0.5 border font-mono text-[10.5px] cursor-pointer',
              'transition-colors duration-fast ease-enter',
              rowed
                ? 'bg-accent-primary-wash text-accent-primary-hi border-[rgba(215,153,33,0.55)]'
                : 'bg-transparent text-fg-muted border-subtle hover:text-fg-secondary hover:border-default',
            ].join(' ')}
          >
            <i data-lucide="rows-3" className="w-3 h-3" />
            by space
          </button>
          <span className="font-mono text-11 text-fg-muted">·</span>
          <span className="font-mono text-11 text-fg-muted whitespace-nowrap">
            {cards.length} cards · {spaces.length} spaces
          </span>
          <span className="flex-1" />

          {activeTag && (
            <div
              className="flex items-center gap-1.5 font-mono text-11 text-fg-secondary pl-2 pr-1.5 py-[3px] rounded-sm"
              style={{ background: 'rgba(215,153,33,0.10)', border: '1px solid rgba(215,153,33,0.35)' }}
            >
              <span className="text-fg-muted">filter</span>
              <span className="text-fg-muted">·</span>
              <Tag label={activeTag} active onClick={() => {}} />
              <button
                onClick={() => setActiveTag(null)}
                className="w-[18px] h-[18px] inline-flex items-center justify-center bg-transparent border border-transparent text-fg-muted rounded-sm cursor-pointer"
              >
                <i data-lucide="x" className="w-3 h-3" />
              </button>
            </div>
          )}
        </div>

        {/* Column header row — present in both modes so labels line up with
            the grid cells below. */}
        <div
          className="flex-none grid px-3.5 pt-3 pb-2 border-b border-subtle"
          style={COL_GRID}
        >
          {COLS.map((col) => (
            <div key={col.id} className="flex items-center gap-2 px-1 whitespace-nowrap">
              <span
                className="w-1.5 h-1.5 rounded-full flex-none"
                style={{ background: col.tone }}
              />
              <span className="font-mono text-11 text-fg-primary tracking-[0.04em]">{col.label}</span>
              <span className="font-mono text-[10px] text-fg-muted">{colCounts[col.id]}</span>
            </div>
          ))}
        </div>

        {/* Body — flat or rowed. A persistent wrapper with a CSS transition
            fades + slides the body on every toggle (enter AND exit symmetric).
            Inside, rowed-mode bands stagger their own mod-enter for a cascade
            that layers on top of the wrapper fade. */}
        <div
          className="flex-1 min-h-0 overflow-x-hidden overflow-y-auto"
          style={{
            opacity: fading ? 0 : 1,
            transform: fading ? 'translateY(-8px)' : 'translateY(0)',
            transition: 'opacity 180ms var(--ease-enter), transform 180ms var(--ease-enter)',
            willChange: 'opacity, transform',
          }}
        >
          {!displayed ? (
            <div
              key="flat"
              className="grid px-3.5 py-3"
              style={{ ...COL_GRID, animation: 'mod-enter 240ms var(--ease-enter) both' }}
            >
              {COLS.map((col) => (
                <div key={col.id} className="p-0.5">
                  <Cell
                    cards={cards.filter((c) => c.col === col.id)}
                    activeTag={activeTag}
                    onTag={onTag}
                    onOpen={setOpenCard}
                    selectedId={openCard?.id}
                    showSpace
                    dropCol={col.id}
                    onMoveCard={moveCard}
                  />
                </div>
              ))}
            </div>
          ) : (
            rowedSpaces.map((s, i) => {
              const rowCards = cards.filter((c) => c.space === s.name);
              return (
                <div
                  key={s.name}
                  className={i > 0 ? 'border-t border-subtle' : ''}
                  style={{
                    animation: 'mod-enter 280ms var(--ease-enter) both',
                    animationDelay: `${i * 50}ms`,
                  }}
                >
                  <div className="flex items-center gap-2 px-3.5 py-2">
                    <SpaceChip name={s.name} />
                    <span className="font-mono text-[10px] text-fg-muted">
                      {rowCards.length} {rowCards.length === 1 ? 'card' : 'cards'}
                    </span>
                  </div>
                  <div className="grid px-3.5 pb-3" style={COL_GRID}>
                    {COLS.map((col) => (
                      <div key={col.id} className="p-0.5">
                        <Cell
                          cards={rowCards.filter((c) => c.col === col.id)}
                          activeTag={activeTag}
                          onTag={onTag}
                          onOpen={setOpenCard}
                          selectedId={openCard?.id}
                          showSpace={false}
                          dropCol={col.id}
                          dropSpace={s.name}
                          onMoveCard={moveCard}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {openCard && (
        <Detail
          card={openCard}
          onClose={() => setOpenCard(null)}
          onTag={onTag}
          activeTag={activeTag}
        />
      )}
    </div>
  );
}

export const meta = { icon: 'kanban-square', name: 'kanban', group: 'thinking' };
