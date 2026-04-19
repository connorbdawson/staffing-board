"use client";

import { useEffect, useMemo, useState } from 'react';
import {
  DAYS,
  dayFullLabel,
  durationHours,
  formatCurrency,
  formatTime,
  generateSchedule,
  isoDateForWeekDay,
  parseTime,
  uuid,
  validateState,
  weekStartMonday,
  type AppState,
  type BusinessHours,
  type DayKey,
  type Employee,
  type EmployeeAvailability,
  type StaffingRequirement,
} from '../lib/staffing';
import { createEmptyAvailability, createSeedState } from '../lib/seed';
import {
  DRIVE_BACKUP_FILE_NAME,
  downloadDriveBackup,
  findLatestDriveBackup,
  requestGoogleDriveAccessToken,
  upsertDriveBackup,
} from '../lib/google-drive';
import { withBasePath } from '../lib/base-path';

type Section = 'dashboard' | 'employees' | 'availability' | 'hours' | 'requirements' | 'schedule' | 'costs' | 'alerts';

const SECTION_LABELS: Record<Section, string> = {
  dashboard: 'Dashboard',
  employees: 'Employees',
  availability: 'Availability',
  hours: 'Business Hours',
  requirements: 'Staffing',
  schedule: 'Weekly Schedule',
  costs: 'Cost Summary',
  alerts: 'Alerts',
};

const STORAGE_KEY = 'staffing-board-state-v1';
const BACKUP_KEY = 'staffing-board-state-backup-v1';
const DRIVE_BACKUP_ID_KEY = 'staffing-board-drive-backup-id-v1';
const DRIVE_BACKUP_AT_KEY = 'staffing-board-drive-backup-at-v1';
const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? '';

function getInitialState(): AppState {
  if (typeof window === 'undefined') return createSeedState();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      const backup = window.localStorage.getItem(BACKUP_KEY);
      if (!backup) return createSeedState();
      const parsedBackup = JSON.parse(backup) as AppState;
      return parsedBackup?.employees?.length ? parsedBackup : createSeedState();
    }
    const parsed = JSON.parse(raw) as AppState;
    if (!parsed?.employees?.length) return createSeedState();
    return parsed;
  } catch {
    try {
      const backup = window.localStorage.getItem(BACKUP_KEY);
      if (!backup) return createSeedState();
      const parsedBackup = JSON.parse(backup) as AppState;
      return parsedBackup?.employees?.length ? parsedBackup : createSeedState();
    } catch {
      return createSeedState();
    }
  }
}

function createEmployeeDraft(): Employee {
  return {
    id: uuid('emp'),
    name: '',
    role: '',
    hourlyWage: 18,
    minPreferredWeeklyHours: 12,
    maxAllowedWeeklyHours: 30,
    priorityLevel: 3,
    active: true,
    notes: '',
  };
}

function updateAvailabilityMap(
  availability: Record<string, EmployeeAvailability>,
  employeeId: string,
  updater: (entry: EmployeeAvailability) => EmployeeAvailability,
) {
  const current = availability[employeeId] ?? createEmptyAvailability();
  return {
    ...availability,
    [employeeId]: updater(current),
  };
}

function loadWeekStart(offsetWeeks: number) {
  const now = new Date();
  now.setDate(now.getDate() + offsetWeeks * 7);
  return weekStartMonday(now);
}

export default function Page() {
  const [state, setState] = useState<AppState>(createSeedState());
  const [loaded, setLoaded] = useState(false);
  const [activeSection, setActiveSection] = useState<Section>('dashboard');
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string>('');
  const [employeeDraft, setEmployeeDraft] = useState<Employee>(createEmployeeDraft());
  const [weekOffset, setWeekOffset] = useState(0);
  const [storageStatus, setStorageStatus] = useState<'loading' | 'saved'>('loading');
  const [driveStatus, setDriveStatus] = useState<'idle' | 'connecting' | 'backing up' | 'restoring' | 'ready' | 'error'>('idle');
  const [driveMessage, setDriveMessage] = useState('Drive backup is optional.');
  const [driveAccessToken, setDriveAccessToken] = useState<string | null>(null);
  const [driveBackupFileId, setDriveBackupFileId] = useState<string | null>(null);
  const [driveBackupAt, setDriveBackupAt] = useState<string | null>(null);
  const [rangeDraft, setRangeDraft] = useState({ day: 'mon' as DayKey, start: '09:00', end: '17:00' });
  const [weeklyUnavailabilityDraft, setWeeklyUnavailabilityDraft] = useState({ day: 'mon' as DayKey, start: '12:00', end: '13:00' });
  const [exceptionDraft, setExceptionDraft] = useState({
    date: new Date().toISOString().slice(0, 10),
    start: '09:00',
    end: '12:00',
    type: 'unavailable' as 'available' | 'unavailable',
    notes: '',
  });
  const [businessHoursDraft, setBusinessHoursDraft] = useState({ day: 'mon' as DayKey, start: '08:00', end: '18:00' });
  const [requirementDraft, setRequirementDraft] = useState({
    day: 'mon' as DayKey,
    start: '09:00',
    end: '12:00',
    requiredStaff: 2,
    role: '',
    notes: '',
  });
  useEffect(() => {
    setState(getInitialState());
    setLoaded(true);
    const savedFileId = window.localStorage.getItem(DRIVE_BACKUP_ID_KEY);
    const savedBackupAt = window.localStorage.getItem(DRIVE_BACKUP_AT_KEY);
    if (savedFileId) setDriveBackupFileId(savedFileId);
    if (savedBackupAt) setDriveBackupAt(savedBackupAt);
  }, []);

  useEffect(() => {
    if (!selectedEmployeeId && state.employees[0]) {
      setSelectedEmployeeId(state.employees[0].id);
      setEmployeeDraft(state.employees[0]);
    }
  }, [selectedEmployeeId, state.employees]);

  const weekStart = useMemo(() => loadWeekStart(weekOffset), [weekOffset]);
  const validationMessages = useMemo(() => validateState(state), [state]);
  const schedule = useMemo(() => generateSchedule(state, weekStart), [state, weekStart]);

  useEffect(() => {
    if (!state.employees.find((employee) => employee.id === selectedEmployeeId)) return;
    const employee = state.employees.find((entry) => entry.id === selectedEmployeeId);
    if (employee) setEmployeeDraft(employee);
  }, [selectedEmployeeId, state.employees]);

  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register(withBasePath('/sw.js')).catch(() => {});
    }
  }, []);

  useEffect(() => {
    if (!loaded) return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    window.localStorage.setItem(BACKUP_KEY, JSON.stringify(state));
    setStorageStatus('saved');
  }, [loaded, state]);

  useEffect(() => {
    if (driveBackupFileId) {
      window.localStorage.setItem(DRIVE_BACKUP_ID_KEY, driveBackupFileId);
    } else {
      window.localStorage.removeItem(DRIVE_BACKUP_ID_KEY);
    }
  }, [driveBackupFileId]);

  useEffect(() => {
    if (driveBackupAt) {
      window.localStorage.setItem(DRIVE_BACKUP_AT_KEY, driveBackupAt);
    } else {
      window.localStorage.removeItem(DRIVE_BACKUP_AT_KEY);
    }
  }, [driveBackupAt]);

  const selectedEmployee = state.employees.find((employee) => employee.id === selectedEmployeeId) ?? state.employees[0];
  const selectedEmployeeAvailability = selectedEmployee ? state.availability[selectedEmployee.id] ?? createEmptyAvailability() : createEmptyAvailability();
  const activeCount = state.employees.filter((employee) => employee.active).length;
  const weeklyHours = Object.values(schedule.employeeHours).reduce((sum, value) => sum + value, 0);
  const underfilledCount = schedule.alerts.filter((alert) => alert.kind === 'understaffed').length;
  const totalAlerts = validationMessages.length + schedule.alerts.length;

  function persistNextState(nextState: AppState) {
    setState({
      ...nextState,
      updatedAt: new Date().toISOString(),
    });
  }

  function saveEmployee(employee: Employee) {
    const nextAvailability = state.availability[employee.id] ?? createEmptyAvailability();
    persistNextState({
      ...state,
      employees: state.employees.some((entry) => entry.id === employee.id)
        ? state.employees.map((entry) => (entry.id === employee.id ? employee : entry))
        : [...state.employees, employee],
      availability: {
        ...state.availability,
        [employee.id]: nextAvailability,
      },
    });
    setSelectedEmployeeId(employee.id);
  }

  function deleteEmployee(employeeId: string) {
    const nextAvailability = { ...state.availability };
    delete nextAvailability[employeeId];
    persistNextState({
      ...state,
      employees: state.employees.filter((entry) => entry.id !== employeeId),
      availability: nextAvailability,
    });
    const replacement = state.employees.find((employee) => employee.id !== employeeId);
    if (replacement) {
      setSelectedEmployeeId(replacement.id);
    }
  }

  function updateSelectedEmployee(next: Partial<Employee>) {
    setEmployeeDraft((current) => ({ ...current, ...next }));
  }

  function addWeeklyAvailability() {
    if (!selectedEmployee) return;
    if (!rangeDraft.start || !rangeDraft.end || parseTime(rangeDraft.start) === null || parseTime(rangeDraft.end) === null) return;
    persistNextState({
      ...state,
      availability: updateAvailabilityMap(state.availability, selectedEmployee.id, (entry) => ({
        ...entry,
        weeklyAvailability: [
          ...entry.weeklyAvailability,
          { day: rangeDraft.day, ranges: [{ start: rangeDraft.start, end: rangeDraft.end }] },
        ],
      })),
    });
  }

  function addWeeklyUnavailability() {
    if (!selectedEmployee) return;
    if (!weeklyUnavailabilityDraft.start || !weeklyUnavailabilityDraft.end) return;
    persistNextState({
      ...state,
      availability: updateAvailabilityMap(state.availability, selectedEmployee.id, (entry) => ({
        ...entry,
        weeklyUnavailability: [
          ...entry.weeklyUnavailability,
          { day: weeklyUnavailabilityDraft.day, ranges: [{ start: weeklyUnavailabilityDraft.start, end: weeklyUnavailabilityDraft.end }] },
        ],
      })),
    });
  }

  function addException() {
    if (!selectedEmployee) return;
    if (!exceptionDraft.date || !exceptionDraft.start || !exceptionDraft.end) return;
    persistNextState({
      ...state,
      availability: updateAvailabilityMap(state.availability, selectedEmployee.id, (entry) => ({
        ...entry,
        exceptions: [
          ...entry.exceptions,
          {
            id: uuid('exc'),
            date: exceptionDraft.date,
            type: exceptionDraft.type,
            start: exceptionDraft.start,
            end: exceptionDraft.end,
            notes: exceptionDraft.notes,
          },
        ],
      })),
    });
  }

  function removeAvailabilityRule(type: 'weeklyAvailability' | 'weeklyUnavailability' | 'exceptions', id: string) {
    if (!selectedEmployee) return;
    persistNextState({
      ...state,
      availability: updateAvailabilityMap(state.availability, selectedEmployee.id, (entry) => ({
        ...entry,
        weeklyAvailability:
          type === 'weeklyAvailability'
            ? entry.weeklyAvailability.filter((item, index) => `${item.day}-${index}` !== id)
            : entry.weeklyAvailability,
        weeklyUnavailability:
          type === 'weeklyUnavailability'
            ? entry.weeklyUnavailability.filter((item, index) => `${item.day}-${index}` !== id)
            : entry.weeklyUnavailability,
        exceptions: type === 'exceptions' ? entry.exceptions.filter((item) => item.id !== id) : entry.exceptions,
      })),
    });
  }

  function addBusinessHours() {
    if (!businessHoursDraft.start || !businessHoursDraft.end) return;
    const nextRule = {
      day: businessHoursDraft.day,
      ranges: [{ start: businessHoursDraft.start, end: businessHoursDraft.end }],
    } as BusinessHours;
    persistNextState({
      ...state,
      businessHours: (() => {
        const existing = state.businessHours.find((entry) => entry.day === businessHoursDraft.day);
        const others = state.businessHours.filter((entry) => entry.day !== businessHoursDraft.day);
        const merged = existing
          ? { ...existing, ranges: [...existing.ranges, ...nextRule.ranges] }
          : nextRule;
        return [...others, merged].sort((a, b) => DAYS.indexOf(a.day) - DAYS.indexOf(b.day));
      })(),
    });
  }

  function deleteBusinessHours(day: DayKey, index: number) {
    persistNextState({
      ...state,
      businessHours: state.businessHours.map((entry) =>
        entry.day === day ? { ...entry, ranges: entry.ranges.filter((_, rangeIndex) => rangeIndex !== index) } : entry,
      ),
    });
  }

  function addRequirement() {
    if (!requirementDraft.start || !requirementDraft.end || requirementDraft.requiredStaff < 1) return;
    persistNextState({
      ...state,
      staffingRequirements: [
        ...state.staffingRequirements,
        {
          id: uuid('req'),
          day: requirementDraft.day,
          start: requirementDraft.start,
          end: requirementDraft.end,
          requiredStaff: requirementDraft.requiredStaff,
          role: requirementDraft.role,
          notes: requirementDraft.notes,
        },
      ].sort((a, b) => DAYS.indexOf(a.day) - DAYS.indexOf(b.day) || (parseTime(a.start) ?? 0) - (parseTime(b.start) ?? 0)),
    });
  }

  function deleteRequirement(id: string) {
    persistNextState({
      ...state,
      staffingRequirements: state.staffingRequirements.filter((entry) => entry.id !== id),
    });
  }

  function clearAllData() {
    const fresh = createSeedState();
    persistNextState(fresh);
    window.localStorage.setItem(BACKUP_KEY, JSON.stringify(fresh));
    setSelectedEmployeeId(fresh.employees[0]?.id ?? '');
    setEmployeeDraft(fresh.employees[0] ?? createEmployeeDraft());
    setWeekOffset(0);
  }

  async function connectDrive() {
    setDriveStatus('connecting');
    setDriveMessage('Opening Google sign-in...');
    try {
      const token = await requestGoogleDriveAccessToken();
      setDriveAccessToken(token);
      setDriveStatus('ready');
      setDriveMessage('Google Drive is connected. You can back up or restore now.');
      return token;
    } catch (error) {
      setDriveStatus('error');
      setDriveMessage(error instanceof Error ? error.message : 'Google Drive connection failed.');
      return null;
    }
  }

  async function ensureDriveToken() {
    if (driveAccessToken) return driveAccessToken;
    return connectDrive();
  }

  async function backUpToDrive() {
    setDriveStatus('backing up');
    setDriveMessage('Saving a backup copy to Google Drive...');
    try {
      const token = await ensureDriveToken();
      if (!token) return;

      const result = await upsertDriveBackup({
        accessToken: token,
        state,
        existingFileId: driveBackupFileId,
      });

      setDriveBackupFileId(result.id);
      setDriveBackupAt(result.modifiedTime ?? new Date().toISOString());
      setDriveStatus('ready');
      setDriveMessage(`Backup saved to Google Drive as ${result.name ?? DRIVE_BACKUP_FILE_NAME}.`);
    } catch (error) {
      setDriveStatus('error');
      setDriveMessage(error instanceof Error ? error.message : 'Drive backup failed.');
    }
  }

  async function restoreFromDrive() {
    setDriveStatus('restoring');
    setDriveMessage('Looking for the latest backup in Google Drive...');
    try {
      const token = await ensureDriveToken();
      if (!token) return;

      const latest = driveBackupFileId
        ? { id: driveBackupFileId }
        : await findLatestDriveBackup(token);

      if (!latest) {
        throw new Error('No Drive backup was found.');
      }

      const restored = await downloadDriveBackup(token, latest.id);
      persistNextState({
        ...restored,
        updatedAt: new Date().toISOString(),
      });
      setSelectedEmployeeId(restored.employees[0]?.id ?? '');
      setEmployeeDraft(restored.employees[0] ?? createEmployeeDraft());
      setDriveBackupFileId(latest.id);
      setDriveBackupAt(new Date().toISOString());
      setDriveStatus('ready');
      setDriveMessage('Restored the latest backup from Google Drive.');
    } catch (error) {
      setDriveStatus('error');
      setDriveMessage(error instanceof Error ? error.message : 'Drive restore failed.');
    }
  }

  function exportState() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `staffing-board-${state.updatedAt.slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function importState(file: File | undefined) {
    if (!file) return;
    const text = await file.text();
    const parsed = JSON.parse(text) as AppState;
    if (!parsed?.employees || !parsed?.businessHours || !parsed?.staffingRequirements) {
      throw new Error('Invalid file');
    }
    persistNextState({
      ...parsed,
      updatedAt: new Date().toISOString(),
    });
    setSelectedEmployeeId(parsed.employees[0]?.id ?? '');
    setEmployeeDraft(parsed.employees[0] ?? createEmployeeDraft());
  }

  const dayCostEntries = DAYS.map((day) => ({
    day,
    cost: schedule.dayCost[day] ?? 0,
  }));

  const assignmentsByDay = DAYS.map((day) => ({
    day,
    assignments: schedule.assignments
      .filter((assignment) => assignment.day === day)
      .sort((a, b) => (parseTime(a.start) ?? 0) - (parseTime(b.start) ?? 0)),
  }));

  const employeeRows = state.employees.map((employee) => ({
    ...employee,
    hours: schedule.employeeHours[employee.id] ?? 0,
    cost: schedule.employeeCost[employee.id] ?? 0,
  }));

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Staffing Board</p>
          <h1>iPad-ready scheduling for small teams</h1>
          <p className="lede">
            Manage availability, hours, staffing rules, and projected labor cost from a clean touch-first workspace.
          </p>
          <p className="sync-line">
            Storage: <strong>{storageStatus}</strong> and saved in this device's browser
          </p>
        </div>
        <div className="topbar-actions">
          <button className="ghost-button" onClick={() => setWeekOffset((value) => value - 1)}>
            Previous week
          </button>
          <button className="ghost-button" onClick={() => setWeekOffset((value) => value + 1)}>
            Next week
          </button>
          <button className="ghost-button" onClick={exportState}>
            Export data
          </button>
          <label className="ghost-button import-button">
            Import data
            <input
              type="file"
              accept="application/json"
              onChange={async (event) => {
                try {
                  await importState(event.target.files?.[0]);
                } catch {
                  alert('That file could not be imported.');
                } finally {
                  event.target.value = '';
                }
              }}
            />
          </label>
          <button className="primary-button" onClick={clearAllData}>
            Reset to seed data
          </button>
        </div>
      </header>

      <section className="summary-strip">
        <Metric label="Active employees" value={`${activeCount}`} />
        <Metric label="Projected weekly cost" value={formatCurrency(schedule.totalCost)} />
        <Metric label="Assigned hours" value={`${weeklyHours.toFixed(1)} hrs`} />
        <Metric label="Alerts" value={`${totalAlerts}`} accent={totalAlerts > 0 ? 'warn' : 'good'} />
      </section>

      <section className="backup-strip">
        <div>
          <p className="eyebrow">Backup</p>
          <h2>Google Drive recovery copy</h2>
          <p className="lede">
            Local storage keeps the live working copy. Google Drive gives you a separate backup that the owner can restore later on the same or a different device.
          </p>
          {!GOOGLE_CLIENT_ID && (
            <p className="sync-line">
              Google Drive backup is not configured yet. Add <strong>NEXT_PUBLIC_GOOGLE_CLIENT_ID</strong> in your deployment settings to enable it.
            </p>
          )}
          <p className="sync-line">
            Status: <strong>{driveStatus}</strong> {driveBackupAt ? `• Last backup ${new Date(driveBackupAt).toLocaleString()}` : ''}
          </p>
          <p className="sync-line">{driveMessage}</p>
        </div>
        <div className="backup-actions">
          <button className="ghost-button" onClick={connectDrive} disabled={!GOOGLE_CLIENT_ID}>
            {driveAccessToken ? 'Reconnect Drive' : 'Connect Google Drive'}
          </button>
          <button className="primary-button" onClick={backUpToDrive} disabled={!GOOGLE_CLIENT_ID}>
            Back up now
          </button>
          <button className="ghost-button" onClick={restoreFromDrive} disabled={!GOOGLE_CLIENT_ID}>
            Restore latest
          </button>
        </div>
      </section>

      <nav className="section-nav" aria-label="Sections">
        {(Object.keys(SECTION_LABELS) as Section[]).map((section) => (
          <button
            key={section}
            className={section === activeSection ? 'section-chip active' : 'section-chip'}
            onClick={() => setActiveSection(section)}
          >
            {SECTION_LABELS[section]}
          </button>
        ))}
      </nav>

      {activeSection === 'dashboard' && (
        <section className="panel-grid two-up">
          <article className="panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Week in view</p>
                <h2>
                  {weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} -{' '}
                  {new Date(weekStart.getTime() + 6 * 86400000).toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                  })}
                </h2>
              </div>
              <p className="muted">{validationMessages.length + schedule.alerts.length} total issues</p>
            </div>
            <div className="stack">
              <p>
                This schedule is generated from your current staffing rules and availability. It prefers higher-priority employees for more hours while protecting min and max weekly hour limits.
              </p>
              <div className="inline-actions">
                <button className="primary-button" onClick={() => setActiveSection('schedule')}>
                  Review schedule
                </button>
                <button className="ghost-button" onClick={() => setActiveSection('alerts')}>
                  View alerts
                </button>
              </div>
            </div>
          </article>
          <article className="panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Quick facts</p>
                <h2>Current configuration</h2>
              </div>
            </div>
            <ul className="key-list">
              <li>
                <strong>{state.staffingRequirements.length}</strong> staffing blocks across the week
              </li>
              <li>
                <strong>{Object.values(schedule.dayCost).filter((value) => value > 0).length}</strong> days with scheduled labor cost
              </li>
              <li>
                <strong>{underfilledCount}</strong> understaffed periods detected
              </li>
              <li>
                <strong>{Object.values(schedule.employeeHours).filter((hours) => hours > 0).length}</strong> employees scheduled this week
              </li>
            </ul>
          </article>
        </section>
      )}

      {activeSection === 'employees' && (
        <section className="panel-grid two-up">
          <article className="panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Employees</p>
                <h2>Manage the team</h2>
              </div>
              <button className="ghost-button" onClick={() => {
                const draft = createEmployeeDraft();
                setEmployeeDraft(draft);
                setSelectedEmployeeId(draft.id);
              }}>
                Add employee
              </button>
            </div>
            <div className="scroll-list">
              {state.employees.map((employee) => (
                <button
                  key={employee.id}
                  className={employee.id === selectedEmployeeId ? 'employee-row active' : 'employee-row'}
                  onClick={() => setSelectedEmployeeId(employee.id)}
                >
                  <span>
                    <strong>{employee.name}</strong>
                    <small>{employee.role || 'No role set'}</small>
                  </span>
                  <span className={employee.active ? 'status-pill good' : 'status-pill muted'}>
                    {employee.active ? 'Active' : 'Inactive'}
                  </span>
                </button>
              ))}
            </div>
          </article>
          <article className="panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Editor</p>
                <h2>{employeeDraft.name ? employeeDraft.name : 'New employee'}</h2>
              </div>
            </div>
            <div className="form-grid">
              <Field label="Name">
                <input value={employeeDraft.name} onChange={(event) => updateSelectedEmployee({ name: event.target.value })} />
              </Field>
              <Field label="Role">
                <input value={employeeDraft.role} onChange={(event) => updateSelectedEmployee({ role: event.target.value })} />
              </Field>
              <Field label="Hourly wage">
                <input type="number" min="0" step="0.5" value={employeeDraft.hourlyWage} onChange={(event) => updateSelectedEmployee({ hourlyWage: Number(event.target.value) })} />
              </Field>
              <Field label="Priority">
                <input type="number" min="1" max="5" value={employeeDraft.priorityLevel} onChange={(event) => updateSelectedEmployee({ priorityLevel: Number(event.target.value) })} />
              </Field>
              <Field label="Min preferred hours">
                <input type="number" min="0" step="0.5" value={employeeDraft.minPreferredWeeklyHours} onChange={(event) => updateSelectedEmployee({ minPreferredWeeklyHours: Number(event.target.value) })} />
              </Field>
              <Field label="Max allowed hours">
                <input type="number" min="0" step="0.5" value={employeeDraft.maxAllowedWeeklyHours} onChange={(event) => updateSelectedEmployee({ maxAllowedWeeklyHours: Number(event.target.value) })} />
              </Field>
              <Field label="Notes">
                <textarea rows={4} value={employeeDraft.notes} onChange={(event) => updateSelectedEmployee({ notes: event.target.value })} />
              </Field>
              <label className="switch-row">
                <input type="checkbox" checked={employeeDraft.active} onChange={(event) => updateSelectedEmployee({ active: event.target.checked })} />
                <span>Active employee</span>
              </label>
            </div>
            <div className="inline-actions">
              <button className="primary-button" onClick={() => saveEmployee(employeeDraft)}>
                Save employee
              </button>
              {selectedEmployee && (
                <button className="ghost-button" onClick={() => deleteEmployee(selectedEmployee.id)}>
                  Delete selected
                </button>
              )}
            </div>
          </article>
        </section>
      )}

      {activeSection === 'availability' && selectedEmployee && (
        <section className="panel-grid two-up">
          <article className="panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Availability</p>
                <h2>{selectedEmployee.name}</h2>
              </div>
              <select value={selectedEmployee.id} onChange={(event) => setSelectedEmployeeId(event.target.value)}>
                {state.employees.map((employee) => (
                  <option key={employee.id} value={employee.id}>
                    {employee.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="subpanel">
              <h3>Weekly availability</h3>
              <div className="form-inline">
                <select value={rangeDraft.day} onChange={(event) => setRangeDraft((current) => ({ ...current, day: event.target.value as DayKey }))}>
                  {DAYS.map((day) => (
                    <option key={day} value={day}>
                      {dayFullLabel(day)}
                    </option>
                  ))}
                </select>
                <input type="time" value={rangeDraft.start} onChange={(event) => setRangeDraft((current) => ({ ...current, start: event.target.value }))} />
                <input type="time" value={rangeDraft.end} onChange={(event) => setRangeDraft((current) => ({ ...current, end: event.target.value }))} />
                <button className="primary-button" onClick={addWeeklyAvailability}>
                  Add
                </button>
              </div>
              <RuleList
                items={selectedEmployeeAvailability.weeklyAvailability.map((item, index) => ({
                  id: `${item.day}-${index}`,
                  label: `${dayFullLabel(item.day)} ${item.ranges.map((range) => `${formatTime(parseTime(range.start) ?? 0)} - ${formatTime(parseTime(range.end) ?? 0)}`).join(', ')}`,
                }))}
                onDelete={(id) => removeAvailabilityRule('weeklyAvailability', id)}
              />
            </div>

            <div className="subpanel">
              <h3>Weekly unavailability</h3>
              <div className="form-inline">
                <select value={weeklyUnavailabilityDraft.day} onChange={(event) => setWeeklyUnavailabilityDraft((current) => ({ ...current, day: event.target.value as DayKey }))}>
                  {DAYS.map((day) => (
                    <option key={day} value={day}>
                      {dayFullLabel(day)}
                    </option>
                  ))}
                </select>
                <input type="time" value={weeklyUnavailabilityDraft.start} onChange={(event) => setWeeklyUnavailabilityDraft((current) => ({ ...current, start: event.target.value }))} />
                <input type="time" value={weeklyUnavailabilityDraft.end} onChange={(event) => setWeeklyUnavailabilityDraft((current) => ({ ...current, end: event.target.value }))} />
                <button className="primary-button" onClick={addWeeklyUnavailability}>
                  Add
                </button>
              </div>
              <RuleList
                items={selectedEmployeeAvailability.weeklyUnavailability.map((item, index) => ({
                  id: `${item.day}-${index}`,
                  label: `${dayFullLabel(item.day)} ${item.ranges.map((range) => `${formatTime(parseTime(range.start) ?? 0)} - ${formatTime(parseTime(range.end) ?? 0)}`).join(', ')}`,
                }))}
                onDelete={(id) => removeAvailabilityRule('weeklyUnavailability', id)}
              />
            </div>
          </article>

          <article className="panel">
            <div className="subpanel">
              <h3>One-time exceptions</h3>
              <div className="form-grid narrow">
                <Field label="Date">
                  <input type="date" value={exceptionDraft.date} onChange={(event) => setExceptionDraft((current) => ({ ...current, date: event.target.value }))} />
                </Field>
                <Field label="Type">
                  <select value={exceptionDraft.type} onChange={(event) => setExceptionDraft((current) => ({ ...current, type: event.target.value as 'available' | 'unavailable' }))}>
                    <option value="unavailable">Unavailable</option>
                    <option value="available">Available</option>
                  </select>
                </Field>
                <Field label="Start">
                  <input type="time" value={exceptionDraft.start} onChange={(event) => setExceptionDraft((current) => ({ ...current, start: event.target.value }))} />
                </Field>
                <Field label="End">
                  <input type="time" value={exceptionDraft.end} onChange={(event) => setExceptionDraft((current) => ({ ...current, end: event.target.value }))} />
                </Field>
                <Field label="Notes">
                  <input value={exceptionDraft.notes} onChange={(event) => setExceptionDraft((current) => ({ ...current, notes: event.target.value }))} />
                </Field>
              </div>
              <button className="primary-button" onClick={addException}>
                Add exception
              </button>
              <RuleList
                items={selectedEmployeeAvailability.exceptions.map((item) => ({
                  id: item.id,
                  label: `${item.date} ${item.start} - ${item.end} ${item.type}${item.notes ? ` • ${item.notes}` : ''}`,
                }))}
                onDelete={(id) => removeAvailabilityRule('exceptions', id)}
              />
            </div>
          </article>
        </section>
      )}

      {activeSection === 'hours' && (
        <section className="panel-grid two-up">
          <article className="panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Business hours</p>
                <h2>Hours of operation</h2>
              </div>
            </div>
            <div className="form-inline">
              <select value={businessHoursDraft.day} onChange={(event) => setBusinessHoursDraft((current) => ({ ...current, day: event.target.value as DayKey }))}>
                {DAYS.map((day) => (
                  <option key={day} value={day}>
                    {dayFullLabel(day)}
                  </option>
                ))}
              </select>
              <input type="time" value={businessHoursDraft.start} onChange={(event) => setBusinessHoursDraft((current) => ({ ...current, start: event.target.value }))} />
              <input type="time" value={businessHoursDraft.end} onChange={(event) => setBusinessHoursDraft((current) => ({ ...current, end: event.target.value }))} />
              <button className="primary-button" onClick={addBusinessHours}>
                Set day hours
              </button>
            </div>
          </article>
          <article className="panel">
            <div className="stack">
              {DAYS.map((day) => {
                const rule = state.businessHours.find((entry) => entry.day === day);
                return (
                  <div key={day} className="day-row">
                    <div>
                      <strong>{dayFullLabel(day)}</strong>
                      <p className="muted">
                        {rule?.ranges.length
                          ? rule.ranges.map((range) => `${range.start} - ${range.end}`).join(', ')
                          : 'Closed'}
                      </p>
                    </div>
                    <div className="row-actions">
                      {(rule?.ranges ?? []).map((range, index) => (
                        <button key={`${day}-${index}`} className="ghost-button small" onClick={() => deleteBusinessHours(day, index)}>
                          Remove
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </article>
        </section>
      )}

      {activeSection === 'requirements' && (
        <section className="panel-grid two-up">
          <article className="panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Staffing requirements</p>
                <h2>Coverage by time block</h2>
              </div>
            </div>
            <div className="form-grid narrow">
              <Field label="Day">
                <select value={requirementDraft.day} onChange={(event) => setRequirementDraft((current) => ({ ...current, day: event.target.value as DayKey }))}>
                  {DAYS.map((day) => (
                    <option key={day} value={day}>
                      {dayFullLabel(day)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Start">
                <input type="time" value={requirementDraft.start} onChange={(event) => setRequirementDraft((current) => ({ ...current, start: event.target.value }))} />
              </Field>
              <Field label="End">
                <input type="time" value={requirementDraft.end} onChange={(event) => setRequirementDraft((current) => ({ ...current, end: event.target.value }))} />
              </Field>
              <Field label="Required staff">
                <input type="number" min="1" step="1" value={requirementDraft.requiredStaff} onChange={(event) => setRequirementDraft((current) => ({ ...current, requiredStaff: Number(event.target.value) }))} />
              </Field>
              <Field label="Role">
                <input value={requirementDraft.role} onChange={(event) => setRequirementDraft((current) => ({ ...current, role: event.target.value }))} />
              </Field>
              <Field label="Notes">
                <input value={requirementDraft.notes} onChange={(event) => setRequirementDraft((current) => ({ ...current, notes: event.target.value }))} />
              </Field>
            </div>
            <button className="primary-button" onClick={addRequirement}>
              Add staffing block
            </button>
          </article>
          <article className="panel">
            <div className="scroll-list">
              {state.staffingRequirements.map((requirement) => (
                <div key={requirement.id} className="requirement-row">
                  <div>
                    <strong>{dayFullLabel(requirement.day)}</strong>
                    <p className="muted">
                      {requirement.start} - {requirement.end} • {requirement.requiredStaff} staff
                    </p>
                    <p className="muted">{requirement.role || 'General coverage'}</p>
                  </div>
                  <button className="ghost-button small" onClick={() => deleteRequirement(requirement.id)}>
                    Remove
                  </button>
                </div>
              ))}
            </div>
          </article>
        </section>
      )}

      {activeSection === 'schedule' && (
        <section className="panel-grid">
          <article className="panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Weekly schedule</p>
                <h2>Generated coverage</h2>
              </div>
              <p className="muted">Auto-generated from the current rules and availability</p>
            </div>
            <div className="day-grid">
              {assignmentsByDay.map(({ day, assignments }) => (
                <div key={day} className="day-card">
                  <div className="day-card-header">
                    <strong>{dayFullLabel(day)}</strong>
                    <span className="muted">
                      {assignments.length} assigned • {schedule.dayCost[day] ? formatCurrency(schedule.dayCost[day]) : '$0'}
                    </span>
                  </div>
                  {assignments.length ? (
                    assignments.map((assignment) => (
                      <div key={assignment.id} className="shift-row">
                        <div>
                          <strong>
                            {assignment.start} - {assignment.end}
                          </strong>
                          <p className="muted">
                            {assignment.employeeName} • {assignment.role || 'No role'}
                          </p>
                        </div>
                        <span className="status-pill">
                          {formatCurrency(assignment.cost)}
                        </span>
                      </div>
                    ))
                  ) : (
                    <p className="muted">No assignments created for this day.</p>
                  )}
                </div>
              ))}
            </div>
          </article>
        </section>
      )}

      {activeSection === 'costs' && (
        <section className="panel-grid two-up">
          <article className="panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Cost summary</p>
                <h2>Weekly labor spend</h2>
              </div>
              <strong className="cost-large">{formatCurrency(schedule.totalCost)}</strong>
            </div>
            <div className="stack">
              {dayCostEntries.map(({ day, cost }) => (
                <div key={day} className="day-row">
                  <strong>{dayFullLabel(day)}</strong>
                  <span>{formatCurrency(cost)}</span>
                </div>
              ))}
            </div>
          </article>
          <article className="panel">
            <div className="scroll-list">
              {employeeRows.map((employee) => (
                <div key={employee.id} className="employee-cost-row">
                  <div>
                    <strong>{employee.name}</strong>
                    <p className="muted">
                      {employee.hours.toFixed(1)} hrs • {employee.role}
                    </p>
                  </div>
                  <div className="right-align">
                    <strong>{formatCurrency(employee.cost)}</strong>
                    <p className="muted">{formatCurrency(employee.hourlyWage)}/hr</p>
                  </div>
                </div>
              ))}
            </div>
          </article>
        </section>
      )}

      {activeSection === 'alerts' && (
        <section className="panel-grid two-up">
          <article className="panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Alerts</p>
                <h2>Validation warnings</h2>
              </div>
            </div>
            <ul className="alert-list">
              {validationMessages.length ? (
                validationMessages.map((warning) => <li key={warning}>{warning}</li>)
              ) : (
                <li>No configuration validation issues.</li>
              )}
            </ul>
          </article>
          <article className="panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Conflicts</p>
                <h2>Schedule flags</h2>
              </div>
            </div>
            <ul className="alert-list">
              {schedule.alerts.length ? (
                schedule.alerts.map((warning) => <li key={warning.id}>{warning.message}</li>)
              ) : (
                <li>No schedule conflicts. Coverage is currently stable.</li>
              )}
            </ul>
          </article>
        </section>
      )}
    </main>
  );
}

function Metric({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: 'good' | 'warn';
}) {
  return (
    <div className={accent ? `metric ${accent}` : 'metric'}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function RuleList({
  items,
  onDelete,
}: {
  items: Array<{ id: string; label: string }>;
  onDelete: (id: string) => void;
}) {
  if (!items.length) {
    return <p className="muted">No entries yet.</p>;
  }

  return (
    <div className="rule-list">
      {items.map((item) => (
        <div key={item.id} className="rule-row">
          <span>{item.label}</span>
          <button className="ghost-button small" onClick={() => onDelete(item.id)}>
            Remove
          </button>
        </div>
      ))}
    </div>
  );
}
