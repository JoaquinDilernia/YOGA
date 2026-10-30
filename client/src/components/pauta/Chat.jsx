import { useCallback, useEffect, useRef, useState } from 'react';
import Report from './Report.jsx';

const EXAMPLES = [
  '¿Qué anuncio trae las ventas más baratas esta semana?',
  '¿Qué fechas conviene empujar y con qué?',
  '¿Cómo vienen las gift cards?',
  '¿Qué post de Instagram promocionarías?',
];
const ACTION_LABELS = {
  recommendation: 'Recomendación para aprobar',
  learning: 'Aprendizaje anotado',
  request: 'Pieza pedida',
};

const when = (iso) =>
  iso ? new Date(iso).toLocaleString('es-AR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';

// La conversación abierta se recuerda por tienda (si el navegador no deja guardar, arranca en la lista)
const openKey = (store) => `turnos_pauta_chat_${store}`;
const readOpen = (store) => {
  try {
    return localStorage.getItem(openKey(store));
  } catch {
    return null;
  }
};
const saveOpen = (store, id) => {
  try {
    if (id) localStorage.setItem(openKey(store), id);
    else localStorage.removeItem(openKey(store));
  } catch {}
};

// Consultas al agente de pauta. Solo contesta y propone: lo que sugiere queda en "Para aprobar"
// onChanged: recarga el resumen (el agente pudo dejar recomendaciones o pedidos de piezas)
export default function Chat({ api, store, available, onError, onChanged, onGoToPending }) {
  const [openId, setOpenIdState] = useState(() => readOpen(store));
  const setOpenId = useCallback(
    (id) => {
      saveOpen(store, id);
      setOpenIdState(id);
    },
    [store],
  );

  return (
    <section className="card pad chat">
      {openId ? (
        <Thread
          api={api}
          id={openId}
          available={available}
          onBack={() => setOpenId(null)}
          onError={onError}
          onChanged={onChanged}
          onGoToPending={onGoToPending}
        />
      ) : (
        <ChatList api={api} available={available} onOpen={setOpenId} onError={onError} onChanged={onChanged} />
      )}
    </section>
  );
}

function Composer({ onSend, busy, disabled, placeholder }) {
  const [text, setText] = useState('');
  const send = () => {
    const message = text.trim();
    if (!message || busy || disabled) return;
    onSend(message, () => setText(''));
  };
  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <textarea
        className="search"
        rows={2}
        maxLength={4000}
        value={text}
        placeholder={placeholder}
        aria-label="Tu consulta"
        disabled={busy || disabled}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
      />
      <button className="btn primary" disabled={busy || disabled || !text.trim()}>
        {busy ? 'Pensando…' : 'Preguntar'}
      </button>
    </form>
  );
}

function Pending({ question }) {
  return (
    <>
      {question && <div className="bubble mine">{question}</div>}
      <p className="muted thinking">El agente está mirando la cuenta para contestarte…</p>
    </>
  );
}

function ChatList({ api, available, onOpen, onError, onChanged }) {
  const [chats, setChats] = useState(null);
  const [pending, setPending] = useState(null);

  const load = useCallback(() => api.chats().then((d) => setChats(d.chats), onError), [api, onError]);
  useEffect(() => {
    load();
  }, [load]);

  const ask = async (message, clear) => {
    setPending(message);
    try {
      const { chat } = await api.startChat(message);
      clear();
      onChanged();
      onOpen(chat.id);
    } catch (err) {
      onError(err);
      // Si el agente falló, la consulta igual quedó guardada: aparece en la lista para reintentar
      load();
    } finally {
      setPending(null);
    }
  };

  return (
    <>
      <h3>Preguntale al agente</h3>
      <p className="muted section-hint">
        Consultá sobre la pauta y la tienda con los datos de hoy. El agente no cambia nada en Meta: si recomienda algo, lo
        deja en “Para aprobar”.
      </p>
      {pending ? (
        <Pending question={pending} />
      ) : (
        <>
          <div className="quick">
            {EXAMPLES.map((q) => (
              <button key={q} className="btn small" disabled={!available} onClick={() => ask(q, () => {})}>
                {q}
              </button>
            ))}
          </div>
          <Composer onSend={ask} disabled={!available} placeholder="Escribí tu consulta…" />
        </>
      )}

      {chats?.length > 0 && (
        <>
          <h4>Conversaciones</h4>
          {chats.map((c) => (
            <button key={c.id} type="button" className="chat-row" onClick={() => onOpen(c.id)}>
              <span>{c.title || 'Consulta'}</span>
              <small className="muted">
                {c.created_by ?? 'Alguien del equipo'} · {when(c.updated_at)} · {c.message_count} mensajes
              </small>
            </button>
          ))}
        </>
      )}
    </>
  );
}

function Thread({ api, id, available, onBack, onError, onChanged, onGoToPending }) {
  const [data, setData] = useState(null);
  const [pending, setPending] = useState(null);
  const [busy, setBusy] = useState(false);
  const end = useRef(null);

  useEffect(() => {
    let alive = true;
    api.chat(id).then(
      (d) => alive && setData(d),
      (err) => {
        if (!alive) return;
        // Si la conversación ya no existe (la borraron), se vuelve a la lista
        if (err.status === 404) onBack();
        else onError(err);
      },
    );
    return () => {
      alive = false;
    };
  }, [api, id, onBack, onError]);

  const messages = data?.messages ?? [];
  const unanswered = !busy && messages.at(-1)?.role === 'user';
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'nearest' });
  }, [messages.length, busy]);

  // Manda la consulta (o reintenta) y muestra la respuesta; si falla, se recarga lo que quedó guardado
  const run = async (fn, question = null) => {
    setPending(question);
    setBusy(true);
    try {
      setData(await fn());
      onChanged();
    } catch (err) {
      onError(err);
      api.chat(id).then(setData, () => {});
    } finally {
      setBusy(false);
      setPending(null);
    }
  };
  const ask = (message, clear) => {
    clear();
    run(() => api.sendChat(id, message), message);
  };
  const remove = async () => {
    if (!window.confirm('¿Borrar la conversación? Lo que dejó el agente para aprobar no se borra.')) return;
    try {
      await api.deleteChat(id);
      onBack();
    } catch (err) {
      onError(err);
    }
  };

  return (
    <>
      <div className="section-head">
        <button className="btn ghost small" onClick={onBack}>
          ← Conversaciones
        </button>
        <button className="btn ghost small" onClick={remove}>
          Borrar
        </button>
      </div>
      {!data && <p className="muted">Cargando…</p>}
      <div className="thread">
        {messages.map((m) =>
          m.role === 'user' ? (
            <div key={m.id} className="bubble mine">
              {m.content}
              <small>
                {m.author ?? 'Alguien del equipo'} · {when(m.created_at)}
              </small>
            </div>
          ) : (
            <div key={m.id} className="bubble">
              <Report text={m.content} />
              {m.actions?.length > 0 && (
                <div className="chat-actions">
                  {m.actions.map((a, i) => (
                    <span key={a.id ?? i} className="tag">
                      {ACTION_LABELS[a.type] ?? ACTION_LABELS.recommendation}: {a.title}
                    </span>
                  ))}
                  {m.actions.some((a) => a.type === 'recommendation') && (
                    <button className="link" onClick={onGoToPending}>
                      Ver en Para aprobar
                    </button>
                  )}
                </div>
              )}
              <small>Agente · {when(m.created_at)}</small>
            </div>
          ),
        )}
        {busy && <Pending question={pending} />}
        {unanswered && (
          <div className="alert chat-retry">
            No pude contestar esta consulta.
            <button className="btn small" disabled={!available} onClick={() => run(() => api.retryChat(id))}>
              Reintentar
            </button>
          </div>
        )}
        <div ref={end} />
      </div>
      <Composer
        onSend={ask}
        busy={busy}
        disabled={!available || unanswered || !data}
        placeholder="Seguí la charla…"
      />
    </>
  );
}
