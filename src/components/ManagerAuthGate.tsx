import { useState } from 'react';
import { Eye, EyeOff, Lock, AlertCircle } from 'lucide-react';
import { loginManager } from '../api';

interface ManagerAuthGateProps {
  isDefaultPassword: boolean;
  onAuthenticated: (isDefault: boolean) => void;
  onBackToStaff: () => void;
}

export function ManagerAuthGate({
  isDefaultPassword,
  onAuthenticated,
  onBackToStaff,
}: ManagerAuthGateProps) {
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password.trim()) {
      setError('Enter the manager password to continue.');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await loginManager(password);
      onAuthenticated(res.isDefaultPassword);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to verify password.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto max-w-md py-12 sm:py-16">
      <div className="rounded-xl border border-slate-200 bg-white p-6 sm:p-8">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-900 text-white">
            <Lock className="h-4 w-4" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-slate-900">Manager Portal</h1>
            <p className="text-xs text-slate-500">Password-protected branch oversight</p>
          </div>
        </div>

        <p className="mt-4 text-sm leading-relaxed text-slate-600">
          Enter the manager password to view Today&apos;s break tracking, collective employee break
          totals, and Date-wise or Month-wise historical records.
        </p>

        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          {error && (
            <div className="flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm text-rose-800">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div>
            <label htmlFor="manager-password" className="block text-sm font-medium text-slate-800">
              Manager Password
            </label>
            <div className="relative mt-1.5">
              <input
                id="manager-password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  if (error) setError(null);
                }}
                placeholder="Enter password"
                autoFocus
                className="w-full rounded-lg border border-slate-300 bg-white py-2.5 pr-10 pl-3.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-teal-700 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setShowPassword((prev) => !prev)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                className="absolute top-1/2 right-2.5 -translate-y-1/2 rounded p-1 text-slate-400 hover:text-slate-700"
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 pt-2">
            <button
              type="button"
              onClick={onBackToStaff}
              className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 whitespace-nowrap shrink-0"
            >
              Back to Staff
            </button>
            <button
              type="submit"
              disabled={loading}
              className="rounded-lg bg-teal-700 px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-60 whitespace-nowrap shrink-0"
            >
              {loading ? 'Verifying...' : 'Unlock Dashboard'}
            </button>
          </div>
        </form>

        {isDefaultPassword && (
          <div className="mt-6 border-t border-slate-100 pt-4 text-xs text-slate-500">
            Initial setup password: <span className="font-mono font-medium text-slate-700">manager123</span> (can be changed inside Manager Settings).
          </div>
        )}
      </div>
    </div>
  );
}
