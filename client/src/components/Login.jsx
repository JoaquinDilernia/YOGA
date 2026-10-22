import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { login } from '../api.js';

export default function Login({ onLogin }) {
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (!password) {
      setError('Ingresá tu contraseña.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      onLogin(await login(password));
    } catch (err) {
      setError(err.message);
      setLoading(false);
    }
  }

  return (
    <main className="login-wrap">
      <form className="login card" onSubmit={submit} noValidate>
        <div className="login-mark" aria-hidden>🧘</div>
        <div className="login-titles">
          <h1>Entrá al panel</h1>
          <p>Turnos, pauta y reportes de Yoga</p>
        </div>
        <div className="field">
          <span>Contraseña</span>
          <div className="pw-wrap">
            <input
              id="login-password"
              aria-label="Contraseña"
              type={show ? 'text' : 'password'}
              autoComplete="current-password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <button
              type="button"
              className="eye"
              onClick={() => setShow((v) => !v)}
              aria-label={show ? 'Ocultar contraseña' : 'Mostrar contraseña'}
            >
              {show ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </div>
        </div>
        {error && <p role="alert" className="alert">{error}</p>}
        <button className="btn primary" disabled={loading}>
          {loading ? 'Entrando…' : 'Entrar'}
        </button>
        <p className="login-help">¿No tenés la contraseña? Pedísela a Joaco.</p>
      </form>
    </main>
  );
}
