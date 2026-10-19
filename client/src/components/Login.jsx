import { useState } from 'react';
import { login } from '../api.js';

export default function Login({ onLogin }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      onLogin(await login(password));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="login card" onSubmit={submit}>
        <div className="login-mark">🧘</div>
        <h1>Panel de turnos</h1>
        <p>Ingresá la contraseña para ver los anotados.</p>
        <input
          type="password"
          placeholder="Contraseña"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <div className="alert">{error}</div>}
        <button className="btn primary" disabled={loading || !password}>
          {loading ? 'Ingresando…' : 'Ingresar'}
        </button>
      </form>
    </div>
  );
}
