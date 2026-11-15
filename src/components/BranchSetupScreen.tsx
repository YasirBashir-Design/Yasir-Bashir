import { useState } from 'react';
import { AlertCircle, ArrowLeft, Building2, LogIn, Mail, UserPlus } from 'lucide-react';
import { openExistingBranch, signupBranch } from '../api';
import type { BranchInfo } from '../types';

interface BranchSetupScreenProps {
  currentBranch?: BranchInfo | null;
  onBranchSignedUp: (result: { branch: BranchInfo; isDefaultPassword: boolean }) => void;
  onBranchOpened: (branch: BranchInfo) => void;
  onCancel?: () => void;
}

export function BranchSetupScreen({
  currentBranch,
  onBranchSignedUp,
  onBranchOpened,
  onCancel,
}: BranchSetupScreenProps) {
  const [mode, setMode] = useState<'signup' | 'open'>('signup');

  // Sign up state
  const [email, setEmail] = useState('');
  const [branchName, setBranchName] = useState('');

  // Open existing branch state
  const [identifier, setIdentifier] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedEmail = email.trim().toLowerCase();
    if (!trimmedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      setError('Please enter a valid email address for this branch.');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const res = await signupBranch({
        email: trimmedEmail,
        branchName: branchName.trim() || undefined,
      });
      onBranchSignedUp({
        branch: res.branch,
        isDefaultPassword: res.isDefaultPassword,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to create branch setup.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleOpenExisting = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!identifier.trim()) {
      setError('Enter your registered branch email ID or Setup ID.');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const res = await openExistingBranch(identifier.trim());
      onBranchOpened(res.branch);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to open branch.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto max-w-xl py-8 sm:py-12">
      {currentBranch && onCancel && (
        <div className="mb-4 flex items-center justify-between">
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 transition-colors hover:text-slate-900"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            <span>Return to {currentBranch.branchName}</span>
          </button>
          <span className="font-mono text-xs text-slate-500 tabular-nums">
            Active Setup ID: {currentBranch.setupCode}
          </span>
        </div>
      )}

      <div className="rounded-xl border border-slate-200 bg-white p-6 sm:p-8">
        <div className="flex items-start gap-3.5">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-slate-900 text-white">
            <Building2 className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl">
              Branch Setup &amp; Sign Up
            </h1>
            <p className="mt-1 text-sm text-slate-600">
              Sign up with your email ID to create a dedicated branch Setup ID, or open an existing
              branch terminal.
            </p>
          </div>
        </div>

        {/* Mode Toggle */}
        <div className="mt-6 grid grid-cols-2 gap-1 rounded-lg bg-slate-100 p-1">
          <button
            type="button"
            onClick={() => {
              setMode('signup');
              setError(null);
            }}
            className={`flex items-center justify-center gap-2 rounded-md px-3 py-2 text-xs font-semibold transition-colors whitespace-nowrap ${
              mode === 'signup'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <UserPlus className="h-3.5 w-3.5" />
            <span>Set Up New Branch</span>
          </button>

          <button
            type="button"
            onClick={() => {
              setMode('open');
              setError(null);
            }}
            className={`flex items-center justify-center gap-2 rounded-md px-3 py-2 text-xs font-semibold transition-colors whitespace-nowrap ${
              mode === 'open'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <LogIn className="h-3.5 w-3.5" />
            <span>Open Existing Branch</span>
          </button>
        </div>

        {error && (
          <div
            role="alert"
            className="mt-5 flex items-center gap-2.5 rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm text-rose-800"
          >
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {mode === 'signup' ? (
          <form onSubmit={handleSignup} className="mt-6 space-y-5">
            <div>
              <label htmlFor="branch-signup-email" className="block text-sm font-medium text-slate-800">
                Branch Email ID
              </label>
              <div className="relative mt-1.5">
                <Mail className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  id="branch-signup-email"
                  type="email"
                  required
                  autoFocus
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    if (error) setError(null);
                  }}
                  placeholder="branch-manager@company.com"
                  className="w-full rounded-lg border border-slate-300 bg-white py-2.5 pr-3.5 pl-10 text-sm text-slate-900 placeholder:text-slate-400 focus:border-teal-700 focus:outline-none"
                />
              </div>
              <p className="mt-1.5 text-xs text-slate-500">
                One email ID represents one isolated branch and generates one unique Setup ID.
              </p>
            </div>

            <div>
              <label htmlFor="branch-signup-name" className="block text-sm font-medium text-slate-800">
                Branch Name <span className="font-normal text-slate-400">(optional)</span>
              </label>
              <input
                id="branch-signup-name"
                type="text"
                maxLength={80}
                value={branchName}
                onChange={(e) => setBranchName(e.target.value)}
                placeholder="e.g. Downtown Main Branch"
                className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-teal-700 focus:outline-none"
              />
            </div>

            <div className="rounded-lg border border-slate-200 bg-slate-50/80 px-4 py-3 text-xs leading-relaxed text-slate-600">
              After sign-up, your Manager Portal opens directly with notifications prompting you to
              create your manager password and add branch staff members.
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-lg bg-teal-700 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? 'Creating Branch Setup...' : 'Create Branch & Open Manager Account'}
            </button>
          </form>
        ) : (
          <form onSubmit={handleOpenExisting} className="mt-6 space-y-5">
            <div>
              <label htmlFor="branch-open-identifier" className="block text-sm font-medium text-slate-800">
                Registered Email ID or Setup ID
              </label>
              <input
                id="branch-open-identifier"
                type="text"
                required
                autoFocus
                value={identifier}
                onChange={(e) => {
                  setIdentifier(e.target.value);
                  if (error) setError(null);
                }}
                placeholder="branch-manager@company.com or SETUP-1234"
                className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-teal-700 focus:outline-none"
              />
              <p className="mt-1.5 text-xs text-slate-500">
                Connects this terminal to an existing branch. Manager Portal access remains protected
                by that branch&apos;s manager password.
              </p>
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-lg bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? 'Opening Branch...' : 'Open Branch Terminal'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
