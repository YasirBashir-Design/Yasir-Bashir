import { useCallback, useEffect, useState } from 'react';
import {
  checkManagerSession,
  fetchCurrentBranch,
  getStoredBranch,
  logoutManager,
  setStoredBranch,
  setStoredManagerToken,
} from './api';
import { BranchSetupScreen } from './components/BranchSetupScreen';
import { ManagerAuthGate } from './components/ManagerAuthGate';
import { ManagerDashboard } from './components/ManagerDashboard';
import { StaffTerminal } from './components/StaffTerminal';
import type { BranchInfo } from './types';

type PageView = 'staff' | 'manager';

function getInitialView(): PageView {
  if (typeof window !== 'undefined' && window.location.pathname.startsWith('/manager')) {
    return 'manager';
  }
  return 'staff';
}

export default function App() {
  const [view, setView] = useState<PageView>(getInitialView);
  const [activeBranch, setActiveBranch] = useState<BranchInfo | null>(() => getStoredBranch());
  const [branchChecked, setBranchChecked] = useState(false);
  const [showBranchSetup, setShowBranchSetup] = useState(false);

  const [managerAuthChecked, setManagerAuthChecked] = useState(false);
  const [managerAuthenticated, setManagerAuthenticated] = useState(false);
  const [isDefaultPassword, setIsDefaultPassword] = useState(false);

  const navigate = useCallback((target: PageView) => {
    setView(target);
    setShowBranchSetup(false);
    const nextPath = target === 'manager' ? '/manager' : '/';
    if (window.location.pathname !== nextPath) {
      window.history.pushState({ view: target }, '', nextPath);
    }
  }, []);

  useEffect(() => {
    const onPopState = () => {
      setView(getInitialView());
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // Verify active branch from URL query or localStorage on initial open
  useEffect(() => {
    let cancelled = false;

    const verifyBranch = async () => {
      try {
        const params = new URLSearchParams(window.location.search);
        const queryBranchId = params.get('branch') || params.get('setup');
        const stored = getStoredBranch();
        const candidateId = queryBranchId || stored?.id;

        if (!candidateId) {
          if (!cancelled) {
            setActiveBranch(null);
            setBranchChecked(true);
          }
          return;
        }

        const res = await fetchCurrentBranch(candidateId);
        if (!cancelled) {
          if (res.branch) {
            setStoredBranch(res.branch);
            setActiveBranch(res.branch);
          } else {
            setStoredBranch(null);
            setActiveBranch(null);
          }
        }
      } catch {
        if (!cancelled) {
          setActiveBranch(getStoredBranch());
        }
      } finally {
        if (!cancelled) {
          setBranchChecked(true);
        }
      }
    };

    verifyBranch();
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshSession = useCallback(async () => {
    if (!activeBranch) {
      setManagerAuthenticated(false);
      setIsDefaultPassword(false);
      setManagerAuthChecked(true);
      return;
    }

    try {
      const res = await checkManagerSession();
      setManagerAuthenticated(res.authenticated);
      setIsDefaultPassword(res.isDefaultPassword);
      if (!res.authenticated) {
        setStoredManagerToken(null);
      }
    } catch {
      setManagerAuthenticated(false);
    } finally {
      setManagerAuthChecked(true);
    }
  }, [activeBranch]);

  useEffect(() => {
    if (branchChecked) {
      refreshSession();
    }
  }, [branchChecked, refreshSession]);

  const handleLockManager = async () => {
    await logoutManager();
    setManagerAuthenticated(false);
    navigate('staff');
  };

  const isSetupView = branchChecked && (!activeBranch || showBranchSetup);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      {/* Three-Zone Top Bar */}
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-[1400px] items-center justify-between gap-8 px-4 py-4 sm:px-6 lg:px-8">
          {/* Zone 1: Single-line Wordmark */}
          <a
            href="/"
            onClick={(e) => {
              e.preventDefault();
              if (activeBranch) {
                navigate('staff');
              } else {
                setShowBranchSetup(true);
              }
            }}
            className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0"
          >
            BranchLedger
          </a>

          {/* Zone 2: Clean Text Navigation Links */}
          <nav className="flex items-center gap-6 text-sm font-medium">
            {activeBranch && (
              <>
                <a
                  href="/"
                  onClick={(e) => {
                    e.preventDefault();
                    navigate('staff');
                  }}
                  className={`border-b-2 py-1 transition-colors whitespace-nowrap shrink-0 ${
                    !isSetupView && view === 'staff'
                      ? 'border-teal-700 text-slate-900'
                      : 'border-transparent text-slate-500 hover:text-slate-900'
                  }`}
                >
                  Staff Page
                </a>
                <a
                  href="/manager"
                  onClick={(e) => {
                    e.preventDefault();
                    navigate('manager');
                  }}
                  className={`border-b-2 py-1 transition-colors whitespace-nowrap shrink-0 ${
                    !isSetupView && view === 'manager'
                      ? 'border-teal-700 text-slate-900'
                      : 'border-transparent text-slate-500 hover:text-slate-900'
                  }`}
                >
                  Manager Page
                </a>
                <button
                  type="button"
                  onClick={() => setShowBranchSetup(true)}
                  className={`border-b-2 py-1 transition-colors whitespace-nowrap shrink-0 ${
                    isSetupView
                      ? 'border-teal-700 text-slate-900'
                      : 'border-transparent text-slate-500 hover:text-slate-900'
                  }`}
                >
                  Branch Setup
                </button>
              </>
            )}
          </nav>

          {/* Zone 3: Single Primary Action */}
          <div className="flex items-center shrink-0">
            {!activeBranch ? (
              <button
                type="button"
                onClick={() => setShowBranchSetup(true)}
                className="rounded-lg bg-teal-700 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-teal-800 whitespace-nowrap shrink-0"
              >
                Branch Setup
              </button>
            ) : isSetupView ? (
              <button
                type="button"
                onClick={() => setShowBranchSetup(false)}
                className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-slate-800 whitespace-nowrap shrink-0"
              >
                Back to Terminal
              </button>
            ) : view === 'manager' && managerAuthenticated ? (
              <button
                type="button"
                onClick={handleLockManager}
                className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-slate-800 whitespace-nowrap shrink-0"
              >
                Lock Manager
              </button>
            ) : view === 'manager' ? (
              <button
                type="button"
                onClick={() => navigate('staff')}
                className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-slate-800 whitespace-nowrap shrink-0"
              >
                Staff Terminal
              </button>
            ) : (
              <button
                type="button"
                onClick={() => navigate('manager')}
                className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-slate-800 whitespace-nowrap shrink-0"
              >
                Manager Login
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="mx-auto max-w-[1400px] px-4 py-8 sm:px-6 lg:px-8">
        {!branchChecked ? (
          <div className="mx-auto max-w-xl py-12">
            <div className="h-72 animate-pulse rounded-xl border border-slate-200 bg-white" />
          </div>
        ) : !activeBranch || showBranchSetup ? (
          <BranchSetupScreen
            currentBranch={activeBranch}
            onBranchSignedUp={({ branch, isDefaultPassword: isDefault }) => {
              setActiveBranch(branch);
              setShowBranchSetup(false);
              setManagerAuthenticated(true);
              setManagerAuthChecked(true);
              setIsDefaultPassword(isDefault);
              navigate('manager');
            }}
            onBranchOpened={(branch) => {
              setActiveBranch(branch);
              setShowBranchSetup(false);
              setManagerAuthenticated(false);
              setManagerAuthChecked(false);
              navigate('staff');
            }}
            onCancel={activeBranch ? () => setShowBranchSetup(false) : undefined}
          />
        ) : (
          <>
            <div className="mb-6 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
              <div className="flex flex-wrap items-center gap-x-2 tabular-nums">
                <span className="font-semibold text-slate-800">{activeBranch.branchName}</span>
                <span aria-hidden="true">·</span>
                <span>{activeBranch.email}</span>
                <span aria-hidden="true">·</span>
                <span className="font-mono text-slate-700">Setup ID {activeBranch.setupCode}</span>
              </div>
              <button
                type="button"
                onClick={() => setShowBranchSetup(true)}
                className="font-medium text-teal-700 transition-colors hover:text-teal-900"
              >
                Switch / Register Branch
              </button>
            </div>

            {view === 'staff' ? (
              <StaffTerminal
                key={activeBranch.id}
                onGoToManager={() => navigate('manager')}
              />
            ) : !managerAuthChecked ? (
              <div className="mx-auto max-w-md py-16">
                <div className="h-64 animate-pulse rounded-xl border border-slate-200 bg-white" />
              </div>
            ) : !managerAuthenticated ? (
              <ManagerAuthGate
                isDefaultPassword={isDefaultPassword}
                onAuthenticated={(isDefault) => {
                  setManagerAuthenticated(true);
                  setIsDefaultPassword(isDefault);
                }}
                onBackToStaff={() => navigate('staff')}
              />
            ) : (
              <ManagerDashboard
                key={activeBranch.id}
                branch={activeBranch}
                isDefaultPassword={isDefaultPassword}
                onPasswordChanged={() => setIsDefaultPassword(false)}
                onSessionExpired={() => {
                  setStoredManagerToken(null);
                  setManagerAuthenticated(false);
                }}
              />
            )}
          </>
        )}
      </main>
    </div>
  );
}
