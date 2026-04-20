"use client";

import { useEffect, useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import {
  DAYS,
  addDays,
  dayFullLabel,
  dayLabel,
  formatCurrency,
  formatTime,
  isoDateForWeekDay,
  scheduleAssignmentKey,
  generateScheduleRange,
  checkScheduleFeasibility,
  reviewScheduleRange,
  parseTime,
  uuid,
  validateState,
  weekStartMonday,
  type AppState,
  type BusinessHours,
  type DayKey,
  type Employee,
  type EmployeeAvailability,
  type GeneratedScheduleRange,
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

type Section = 'home' | 'dashboard' | 'employees' | 'availability' | 'schedules' | 'guide';
type PeriodMode = 'thisWeek' | 'nextWeek' | 'twoWeeks' | 'custom';

const SECTION_LABELS: Record<Section, string> = {
  home: 'Home',
  dashboard: 'Dashboard',
  employees: 'Employees',
  availability: 'Availability',
  schedules: 'Schedules',
  guide: 'User Guide',
};

const WORKSPACE_SECTIONS: Section[] = ['home', 'schedules', 'availability', 'employees', 'dashboard', 'guide'];

const STORAGE_KEY = 'staffing-board-state-v1';
const BACKUP_KEY = 'staffing-board-state-backup-v1';
const DRIVE_BACKUP_ID_KEY = 'staffing-board-drive-backup-id-v1';
const DRIVE_BACKUP_AT_KEY = 'staffing-board-drive-backup-at-v1';
const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? '';

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

function createPeriodDraft() {
  const weekStart = weekStartMonday(new Date());
  return {
    mode: 'thisWeek' as PeriodMode,
    customStart: weekStart.toISOString().slice(0, 10),
    customEnd: addDays(weekStart, 6).toISOString().slice(0, 10),
  };
}

function normalizeState(value: Partial<AppState> | null | undefined): AppState {
  const fallback = createSeedState();
  return {
    employees: value?.employees ?? fallback.employees,
    availability: value?.availability ?? fallback.availability,
    businessHours: value?.businessHours ?? fallback.businessHours,
    staffingRequirements: value?.staffingRequirements ?? fallback.staffingRequirements,
    scheduleOverrides: value?.scheduleOverrides ?? {},
    schedulePublishedAt: value?.schedulePublishedAt ?? null,
    updatedAt: value?.updatedAt ?? fallback.updatedAt,
  };
}

function getInitialState(): AppState {
  if (typeof window === 'undefined') return createSeedState();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      const backup = window.localStorage.getItem(BACKUP_KEY);
      if (!backup) return createSeedState();
      const parsedBackup = JSON.parse(backup) as Partial<AppState>;
      return parsedBackup?.employees?.length ? normalizeState(parsedBackup) : createSeedState();
    }
    const parsed = JSON.parse(raw) as Partial<AppState>;
    if (!parsed?.employees?.length) return createSeedState();
    return normalizeState(parsed);
  } catch {
    try {
      const backup = window.localStorage.getItem(BACKUP_KEY);
      if (!backup) return createSeedState();
      const parsedBackup = JSON.parse(backup) as Partial<AppState>;
      return parsedBackup?.employees?.length ? normalizeState(parsedBackup) : createSeedState();
    } catch {
      return createSeedState();
    }
  }
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

function resolvePeriod(period: { mode: PeriodMode; customStart: string; customEnd: string }) {
  const thisWeek = weekStartMonday(new Date());
  let start = new Date(thisWeek);
  let end = addDays(thisWeek, 6);

  if (period.mode === 'nextWeek') {
    start = addDays(thisWeek, 7);
    end = addDays(start, 6);
  } else if (period.mode === 'twoWeeks') {
    start = new Date(thisWeek);
    end = addDays(thisWeek, 13);
  } else if (period.mode === 'custom') {
    const startDate = new Date(`${period.customStart}T12:00:00`);
    const endDate = new Date(`${period.customEnd}T12:00:00`);
    if (!Number.isNaN(startDate.getTime()) && !Number.isNaN(endDate.getTime())) {
      const safeStart = startDate <= endDate ? startDate : endDate;
      const safeEnd = startDate <= endDate ? endDate : startDate;
      start = weekStartMonday(safeStart);
      end = addDays(weekStartMonday(safeEnd), 6);
    }
  }

  const weeks: Date[] = [];
  let cursor = new Date(start);
  while (cursor <= end) {
    weeks.push(new Date(cursor));
    cursor = addDays(cursor, 7);
  }

  return {
    start,
    end,
    weeks,
    label: `${start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} - ${end.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    })}`,
  };
}

function formatRange(start: string, end: string) {
  return `${formatTime(parseTime(start) ?? 0)} - ${formatTime(parseTime(end) ?? 0)}`;
}

function formatCalendarTime(value: string) {
  const minutes = parseTime(value);
  if (minutes === null) return value;

  const normalized = ((minutes % 1440) + 1440) % 1440;
  const hour = Math.floor(normalized / 60);
  const minute = normalized % 60;
  const displayHour = hour % 12 === 0 ? 12 : hour % 12;

  return minute === 0 ? String(displayHour) : `${displayHour}:${minute.toString().padStart(2, '0')}`;
}

function formatCalendarShiftLine(start: string, end: string, employeeName: string) {
  return `${formatCalendarTime(start)}-${formatCalendarTime(end)} ${employeeName}`;
}

function formatWeekLabel(start: Date, end: Date) {
  return `${start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} - ${end.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  })}`;
}

function formatMonthYear(date: Date) {
  return date.toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
  });
}

function monthGridStart(date: Date) {
  const result = new Date(date);
  result.setHours(12, 0, 0, 0);
  result.setDate(1);
  result.setDate(result.getDate() - result.getDay());
  return result;
}

function formatDayDate(date: Date) {
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

function sectionHref(section: Section) {
  return `#${section}`;
}

function sectionFromHash() {
  if (typeof window === 'undefined') return 'home' as Section;
  const hash = window.location.hash.replace('#', '') as Section;
  return WORKSPACE_SECTIONS.includes(hash) ? hash : 'home';
}

function isDateInPeriod(date: string, start: Date, end: Date) {
  const value = date.slice(0, 10);
  const startValue = start.toISOString().slice(0, 10);
  const endValue = end.toISOString().slice(0, 10);
  return value >= startValue && value <= endValue;
}

function buildSortedRequirements(requirements: StaffingRequirement[]) {
  return [...requirements].sort((a, b) => {
    const dayDiff = DAYS.indexOf(a.day) - DAYS.indexOf(b.day);
    if (dayDiff !== 0) return dayDiff;
    return (parseTime(a.start) ?? 0) - (parseTime(b.start) ?? 0);
  });
}

function buildAssignmentsForRequirement(schedule: GeneratedScheduleRange['weeks'][number]['schedule'], requirementId: string) {
  return schedule.assignments.filter((assignment) => assignment.blockId === requirementId);
}

function buildWeekSections(range: GeneratedScheduleRange, requirements: StaffingRequirement[]) {
  return range.weeks.map((week) => {
    const sortedRequirements = buildSortedRequirements(requirements);
    const dayCards = DAYS.map((day) => ({
      day,
      requirements: sortedRequirements
        .filter((requirement) => requirement.day === day)
        .map((requirement) => {
          const assignments = buildAssignmentsForRequirement(week.schedule, requirement.id);
          return {
            requirement,
            assignments,
          };
        }),
      dayAssignments: week.schedule.assignments.filter((assignment) => assignment.day === day),
      dayCost: week.schedule.dayCost[day] ?? 0,
    }));

    return {
      week,
      dayCards,
    };
  });
}

export default function Page() {
  const [state, setState] = useState<AppState>(createSeedState());
  const [loaded, setLoaded] = useState(false);
  const [activeSection, setActiveSection] = useState<Section>('home');
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string>('');
  const [employeeDraft, setEmployeeDraft] = useState<Employee>(createEmployeeDraft());
  const [period, setPeriod] = useState(createPeriodDraft());
  const [storageStatus, setStorageStatus] = useState<'loading' | 'saved'>('loading');
  const [driveStatus, setDriveStatus] = useState<'idle' | 'connecting' | 'backing up' | 'restoring' | 'ready' | 'error'>('idle');
  const [driveMessage, setDriveMessage] = useState('Drive backup is optional.');
  const [driveAccessToken, setDriveAccessToken] = useState<string | null>(null);
  const [driveBackupFileId, setDriveBackupFileId] = useState<string | null>(null);
  const [driveBackupAt, setDriveBackupAt] = useState<string | null>(null);
  const [showDriveMenu, setShowDriveMenu] = useState(false);
  const [lastGeneratedAt, setLastGeneratedAt] = useState<string | null>(null);
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
    setActiveSection(sectionFromHash());
    setLoaded(true);
    const savedFileId = window.localStorage.getItem(DRIVE_BACKUP_ID_KEY);
    const savedBackupAt = window.localStorage.getItem(DRIVE_BACKUP_AT_KEY);
    if (savedFileId) setDriveBackupFileId(savedFileId);
    if (savedBackupAt) setDriveBackupAt(savedBackupAt);
  }, []);

  useEffect(() => {
    const handleHashChange = () => setActiveSection(sectionFromHash());
    window.addEventListener('hashchange', handleHashChange);
    window.addEventListener('popstate', handleHashChange);
    return () => {
      window.removeEventListener('hashchange', handleHashChange);
      window.removeEventListener('popstate', handleHashChange);
    };
  }, []);

  useEffect(() => {
    if (!selectedEmployeeId && state.employees[0]) {
      setSelectedEmployeeId(state.employees[0].id);
      setEmployeeDraft(state.employees[0]);
    }
  }, [selectedEmployeeId, state.employees]);

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
  const validationMessages = useMemo(() => validateState(state), [state]);
  const selectedPeriod = useMemo(() => resolvePeriod(period), [period]);
  const generatedRange = useMemo(
    () => generateScheduleRange(state, selectedPeriod.start, selectedPeriod.end),
    [state, selectedPeriod.start, selectedPeriod.end],
  );
  const reviewedRange = useMemo(
    () => reviewScheduleRange(generatedRange, state, state.scheduleOverrides),
    [generatedRange, state, state.scheduleOverrides],
  );
  const feasibility = useMemo(
    () => checkScheduleFeasibility(state, selectedPeriod.start, selectedPeriod.end),
    [state, selectedPeriod.start, selectedPeriod.end],
  );
  const weekSections = useMemo(() => buildWeekSections(reviewedRange, state.staffingRequirements), [reviewedRange, state.staffingRequirements]);

  const activeCount = state.employees.filter((employee) => employee.active).length;
  const activeEmployees = state.employees.filter((employee) => employee.active);
  const totalAssignedHours = Object.values(reviewedRange.employeeHours).reduce((sum, value) => sum + value, 0);
  const totalAlerts = validationMessages.length + reviewedRange.alerts.length;
  const underfilledCount = reviewedRange.alerts.filter((alert) => alert.kind === 'understaffed').length;

  function persistNextState(nextState: AppState) {
    const publishedAt = nextState.schedulePublishedAt !== state.schedulePublishedAt ? nextState.schedulePublishedAt : null;
    setState({
      ...nextState,
      schedulePublishedAt: publishedAt,
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
    goToSection('employees');
  }

  function deleteEmployee(employeeId: string) {
    const employee = state.employees.find((entry) => entry.id === employeeId);
    if (employee && !window.confirm(`Delete ${employee.name}? This also removes their availability.`)) return;
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
    } else {
      setSelectedEmployeeId('');
      setEmployeeDraft(createEmployeeDraft());
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
    if (!window.confirm('Reset all data to the sample company? This replaces the current browser copy.')) return;
    const fresh = createSeedState();
    persistNextState(fresh);
    window.localStorage.setItem(BACKUP_KEY, JSON.stringify(fresh));
    setSelectedEmployeeId(fresh.employees[0]?.id ?? '');
    setEmployeeDraft(fresh.employees[0] ?? createEmployeeDraft());
    setPeriod(createPeriodDraft());
    goToSection('home');
    setLastGeneratedAt(null);
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

      const latest = driveBackupFileId ? { id: driveBackupFileId } : await findLatestDriveBackup(token);
      if (!latest) {
        throw new Error('No Drive backup was found.');
      }

      const restored = await downloadDriveBackup(token, latest.id);
      persistNextState({
        ...normalizeState(restored),
        updatedAt: new Date().toISOString(),
      });
      setSelectedEmployeeId(restored.employees[0]?.id ?? '');
      setEmployeeDraft(restored.employees[0] ?? createEmployeeDraft());
      setDriveBackupFileId(latest.id);
      setDriveBackupAt(new Date().toISOString());
      setDriveStatus('ready');
      setDriveMessage('Restored the latest backup from Google Drive.');
      goToSection('home');
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
    const parsed = normalizeState(JSON.parse(text) as Partial<AppState>);
    if (!parsed?.employees || !parsed?.businessHours || !parsed?.staffingRequirements) {
      throw new Error('Invalid file');
    }
    persistNextState({
      ...parsed,
      updatedAt: new Date().toISOString(),
    });
    setSelectedEmployeeId(parsed.employees[0]?.id ?? '');
    setEmployeeDraft(parsed.employees[0] ?? createEmployeeDraft());
    goToSection('home');
  }

  function goToSection(section: Section) {
    setActiveSection(section);
    if (typeof window !== 'undefined') {
      window.history.pushState(null, '', `${window.location.pathname}${window.location.search}#${section}`);
    }
  }

  function refreshSchedule() {
    setLastGeneratedAt(new Date().toISOString());
  }

  function setScheduleOverride(assignmentKey: string, value: string) {
    const nextOverrides = { ...state.scheduleOverrides };
    if (value === '__inherit__') {
      delete nextOverrides[assignmentKey];
    } else if (value === '__clear__') {
      nextOverrides[assignmentKey] = null;
    } else {
      nextOverrides[assignmentKey] = value;
    }
    persistNextState({
      ...state,
      scheduleOverrides: nextOverrides,
    });
  }

  function clearScheduleOverrides() {
    if (!window.confirm('Clear all manual schedule overrides for this browser copy?')) return;
    persistNextState({
      ...state,
      scheduleOverrides: {},
    });
  }

  function publishSchedule() {
    const blockingAlerts = reviewedRange.alerts.filter((alert) => alert.kind !== 'hours');
    if (blockingAlerts.length > 0) {
      alert('Resolve the remaining conflicts and understaffing before publishing.');
      return;
    }
    persistNextState({
      ...state,
      schedulePublishedAt: new Date().toISOString(),
    });
  }

  const activePeriodLabel = period.mode === 'custom' ? selectedPeriod.label : selectedPeriod.label;

  const employeeRows = state.employees.map((employee) => ({
    ...employee,
    hours: reviewedRange.employeeHours[employee.id] ?? 0,
    cost: reviewedRange.employeeCost[employee.id] ?? 0,
  }));

  const availableExceptionRows = selectedEmployeeAvailability.exceptions.filter((entry) => isDateInPeriod(entry.date, selectedPeriod.start, selectedPeriod.end));
  const scheduleWarnings = [...validationMessages, ...reviewedRange.alerts.map((warning) => warning.message)];

  return (
    <main className="shell">
      <header className="topbar">
        <div className="topbar-copy">
          <p className="eyebrow">Staffing Board</p>
          <h1>Staffing Board</h1>
          <p className="sync-line">
            Storage: <strong>{storageStatus}</strong> and saved in this device's browser
          </p>
        </div>
        <div className="topbar-actions">
          <button className="ghost-button" onClick={() => setShowDriveMenu(true)}>
            Google Drive
          </button>
          <button className="ghost-button" onClick={clearAllData}>
            Reset to seed
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
        </div>
      </header>

      <nav className="section-nav" aria-label="Sections">
        {WORKSPACE_SECTIONS.map((section) => (
          <a
            key={section}
            className={section === activeSection ? 'section-chip active' : 'section-chip'}
            href={sectionHref(section)}
            onClick={() => goToSection(section)}
          >
            {SECTION_LABELS[section]}
          </a>
        ))}
      </nav>

      {showDriveMenu && (
        <div className="drive-overlay" role="presentation" onClick={() => setShowDriveMenu(false)}>
          <aside className="drive-menu panel" role="dialog" aria-modal="true" aria-label="Google Drive menu" onClick={(event) => event.stopPropagation()}>
            <div className="panel-header">
              <div>
                <p className="eyebrow">Google Drive</p>
                <h2>Backup and restore</h2>
              </div>
              <button className="ghost-button small" onClick={() => setShowDriveMenu(false)}>
                Close
              </button>
            </div>
            <p className="lede">
              Use Drive as the recovery copy. The live working copy still stays in this iPad browser so the app remains fast and simple.
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
              <button className="ghost-button" onClick={exportState}>
                Export JSON
              </button>
            </div>
          </aside>
        </div>
      )}

      {activeSection === 'home' && (
        <section className="home-workspace">
          <div className="workspace-heading">
            <div>
              <p className="eyebrow">Workspaces</p>
              <h2>Choose what you need to work on</h2>
            </div>
            <span className="muted">{activePeriodLabel}</span>
          </div>
          <section className="action-launcher">
            <ActionTile
              title="Schedules"
              description="Business hours, staffing needs, review, publish, and PDF export."
              buttonLabel="Open schedules"
              href={sectionHref('schedules')}
              onClick={() => goToSection('schedules')}
            />
            <ActionTile
              title="Availability"
              description="Weekly availability, unavailable blocks, and date exceptions."
              buttonLabel="Open availability"
              href={sectionHref('availability')}
              onClick={() => goToSection('availability')}
            />
            <ActionTile
              title="Employees"
              description="Names, roles, wages, hour limits, and priority."
              buttonLabel="Open employees"
              href={sectionHref('employees')}
              onClick={() => goToSection('employees')}
            />
            <ActionTile
              title="Dashboard"
              description="Quick totals for cost, hours, alerts, and schedule health."
              buttonLabel="Open dashboard"
              href={sectionHref('dashboard')}
              onClick={() => goToSection('dashboard')}
            />
            <ActionTile
              title="User Guide"
              description="A plain-language walkthrough for the owner and managers."
              buttonLabel="Open guide"
              href={sectionHref('guide')}
              onClick={() => goToSection('guide')}
            />
          </section>
        </section>
      )}

      {activeSection === 'dashboard' && (
        <section className="dashboard-workspace">
          <section className="summary-strip">
            <Metric label="Active employees" value={`${activeCount}`} />
            <Metric label="Selected period cost" value={formatCurrency(reviewedRange.totalCost)} />
            <Metric label="Assigned hours" value={`${totalAssignedHours.toFixed(1)} hrs`} />
            <Metric label="Alerts" value={`${totalAlerts}`} accent={totalAlerts > 0 ? 'warn' : 'good'} />
          </section>
          <section className="panel-grid dashboard-grid">
          <article className="panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Period</p>
                <h2>{activePeriodLabel}</h2>
              </div>
              <button className="ghost-button" onClick={() => goToSection('schedules')}>
                Review schedule
              </button>
            </div>
            <p className="lede">
              The current period is the one you will see in Availability and Schedules. Use the buttons below to jump straight to the next task.
            </p>
            <div className="mini-nav">
              <button className="primary-button" onClick={() => goToSection('employees')}>
                Employees
              </button>
              <button className="ghost-button" onClick={() => goToSection('availability')}>
                Availability
              </button>
              <button className="ghost-button" onClick={() => goToSection('schedules')}>
                Schedules
              </button>
            </div>
          </article>
          <article className="panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Current configuration</p>
                <h2>Quick facts</h2>
              </div>
            </div>
            <ul className="key-list">
              <li>
                <strong>{state.staffingRequirements.length}</strong> staffing blocks across the period
              </li>
              <li>
                <strong>{Object.values(reviewedRange.employeeHours).filter((hours) => hours > 0).length}</strong> employees scheduled
              </li>
              <li>
                <strong>{underfilledCount}</strong> understaffed periods detected
              </li>
              <li>
                <strong>{formatCurrency(reviewedRange.totalCost)}</strong> projected period labor cost
              </li>
            </ul>
          </article>
          </section>
        </section>
      )}

      {activeSection === 'employees' && (
        <section className="panel-grid two-up">
          <article className="panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Employees</p>
                <h2>Team list</h2>
              </div>
              <button
                className="ghost-button"
                onClick={() => {
                  const draft = createEmployeeDraft();
                  setEmployeeDraft(draft);
                  setSelectedEmployeeId(draft.id);
                }}
              >
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
                    <small>
                      {employee.role || 'No role'} • {formatCurrency(employee.hourlyWage)}/hr
                    </small>
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
              <Field label="Min weekly hours">
                <input type="number" min="0" step="0.5" value={employeeDraft.minPreferredWeeklyHours} onChange={(event) => updateSelectedEmployee({ minPreferredWeeklyHours: Number(event.target.value) })} />
              </Field>
              <Field label="Max weekly hours">
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
        <section className="panel-grid availability-grid">
          <article className="panel workspace-intro">
            <div className="workspace-heading">
              <div>
                <p className="eyebrow">Availability</p>
                <h2>Set who can work during the selected dates</h2>
              </div>
              <select value={selectedEmployee.id} onChange={(event) => setSelectedEmployeeId(event.target.value)}>
                {state.employees.map((employee) => (
                  <option key={employee.id} value={employee.id}>
                    {employee.name}
                  </option>
                ))}
              </select>
            </div>
            <PeriodSelector period={period} setPeriod={setPeriod} />
            <WeekDateStrip start={selectedPeriod.start} end={selectedPeriod.end} />
          </article>
          <article className="panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Employee</p>
                <h2>{selectedEmployee.name}</h2>
              </div>
            </div>
            <div className="employee-selector-list">
              {state.employees.map((employee) => (
                <button
                  key={employee.id}
                  className={employee.id === selectedEmployee.id ? 'employee-row active' : 'employee-row'}
                  onClick={() => setSelectedEmployeeId(employee.id)}
                >
                  <span>
                    <strong>{employee.name}</strong>
                    <small>{employee.role || 'Team member'}</small>
                  </span>
                </button>
              ))}
            </div>

            <div className="subpanel">
              <div className="panel-header compact">
                <div>
                  <h3>Add available hours</h3>
                  <p className="muted">These hours repeat on the selected weekday.</p>
                </div>
              </div>
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
                  label: `${dayFullLabel(item.day)} ${item.ranges.map((range) => formatRange(range.start, range.end)).join(', ')}`,
                }))}
                onDelete={(id) => removeAvailabilityRule('weeklyAvailability', id)}
              />
            </div>

            <div className="subpanel">
              <div className="panel-header compact">
                <div>
                  <h3>Add unavailable hours</h3>
                  <p className="muted">Use this for recurring blocks the employee cannot work.</p>
                </div>
              </div>
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
                  label: `${dayFullLabel(item.day)} ${item.ranges.map((range) => formatRange(range.start, range.end)).join(', ')}`,
                }))}
                onDelete={(id) => removeAvailabilityRule('weeklyUnavailability', id)}
              />
            </div>
          </article>

          <article className="panel">
            <div className="subpanel">
              <div className="panel-header compact">
                <div>
                  <h3>Date-specific exceptions</h3>
                  <p className="muted">
                    Add a change for one exact date without rewriting recurring availability.
                  </p>
                </div>
              </div>
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
              <div className="spacer" />
              <div className="panel-header compact">
                <div>
                  <h3>Exceptions in this period</h3>
                  <p className="muted">{selectedPeriod.label}</p>
                </div>
              </div>
              <RuleList
                items={availableExceptionRows.map((item) => ({
                  id: item.id,
                  label: `${item.date} ${item.start} - ${item.end} ${item.type}${item.notes ? ` • ${item.notes}` : ''}`,
                }))}
                onDelete={(id) => removeAvailabilityRule('exceptions', id)}
              />
            </div>
          </article>
        </section>
      )}

      {activeSection === 'schedules' && (
        <section className="panel-grid schedule-grid">
          <article className="panel schedule-command">
            <div className="workspace-heading">
              <div>
                <p className="eyebrow">Schedule Workspace</p>
                <h2>{selectedPeriod.label}</h2>
              </div>
              <div className="row-actions">
                <button className="primary-button" onClick={refreshSchedule}>
                  Generate Schedule
                </button>
                <button className="ghost-button" onClick={() => window.print()}>
                  Export Whiteboard Calendar PDF
                </button>
              </div>
            </div>
            <div className="schedule-steps" aria-label="Schedule workflow">
              <div className="schedule-step">
                <span>1</span>
                <strong>Choose Dates</strong>
                <p>{formatDayDate(selectedPeriod.start)} to {formatDayDate(selectedPeriod.end)}</p>
              </div>
              <div className="schedule-step">
                <span>2</span>
                <strong>Set Coverage</strong>
                <p>{state.staffingRequirements.length} staffing block(s) and {activeEmployees.length} active employee(s)</p>
              </div>
              <div className={reviewedRange.alerts.some((alert) => alert.kind !== 'hours') ? 'schedule-step warn' : 'schedule-step good'}>
                <span>3</span>
                <strong>Review & Publish</strong>
                <p>{reviewedRange.alerts.some((alert) => alert.kind !== 'hours') ? 'Resolve conflicts before publish' : 'Ready to publish or export'}</p>
              </div>
            </div>
          </article>

          <article className="panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Schedules</p>
                <h2>Selected period</h2>
              </div>
            </div>
            <PeriodSelector period={period} setPeriod={setPeriod} />
            <div className="review-banner">
              <div>
                <p className="eyebrow">Review</p>
                <strong>{state.schedulePublishedAt ? 'Published' : 'Draft review ready'}</strong>
                <p className="muted">
                  {state.schedulePublishedAt
                    ? `Published ${new Date(state.schedulePublishedAt).toLocaleString()}`
                    : 'Use the controls in the calendar to swap or clear shifts before publishing.'}
                </p>
              </div>
              <div className="row-actions">
                <button className="ghost-button" onClick={clearScheduleOverrides} disabled={!Object.keys(state.scheduleOverrides).length}>
                  Clear overrides
                </button>
                <button className="primary-button" onClick={publishSchedule} disabled={reviewedRange.alerts.some((alert) => alert.kind !== 'hours')}>
                  Publish reviewed schedule
                </button>
              </div>
            </div>
            <div className={feasibility.feasible ? 'feasibility-card good' : 'feasibility-card warn'}>
              <div>
                <p className="eyebrow">Preflight</p>
                <strong>{feasibility.feasible ? 'Schedule is feasible' : 'Schedule needs attention'}</strong>
                <p className="muted">
                  Demand: {feasibility.totalRequiredHours.toFixed(1)} hrs • Capacity: {feasibility.estimatedCapacityHours.toFixed(1)} hrs
                </p>
              </div>
              <span className="status-pill">{Math.round(feasibility.coverageRatio * 100)}% capacity</span>
            </div>
            {feasibility.issues.length > 0 && (
              <ul className="alert-list">
                {feasibility.issues.slice(0, 4).map((issue) => (
                  <li key={`${issue.kind}-${issue.message}`}>
                    <strong>{issue.message}</strong>
                    {(issue.eligibleEmployees?.length || issue.requiredStaff || issue.eligibleStaff !== undefined) && (
                      <p className="muted">
                        {issue.requiredStaff !== undefined ? `Need ${issue.requiredStaff} employee(s)` : null}
                        {issue.eligibleStaff !== undefined ? `${issue.requiredStaff !== undefined ? ' • ' : ''}${issue.eligibleStaff} eligible` : null}
                        {issue.eligibleEmployees?.length ? `${issue.requiredStaff !== undefined || issue.eligibleStaff !== undefined ? ' • ' : ''}Eligible: ${issue.eligibleEmployees.join(', ')}` : ' • Eligible: none'}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <div className="inline-actions">
              <button className="ghost-button" onClick={() => window.print()}>
                Export Whiteboard Calendar PDF
              </button>
              <button className="ghost-button" onClick={() => setShowDriveMenu(true)}>
                Google Drive
              </button>
            </div>
            {lastGeneratedAt && <p className="sync-line">Last refreshed {new Date(lastGeneratedAt).toLocaleString()}</p>}
          </article>

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
            <div className="stack">
              {DAYS.map((day) => {
                const rule = state.businessHours.find((entry) => entry.day === day);
                return (
                  <div key={day} className="day-row">
                    <div>
                      <strong>{dayFullLabel(day)}</strong>
                      <p className="muted">
                        {rule?.ranges.length
                          ? rule.ranges.map((range) => formatRange(range.start, range.end)).join(', ')
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
            <div className="spacer" />
            <div className="scroll-list">
              {buildSortedRequirements(state.staffingRequirements).map((requirement) => (
                <div key={requirement.id} className="requirement-row">
                  <div>
                    <strong>{dayFullLabel(requirement.day)}</strong>
                    <p className="muted">
                      {formatRange(requirement.start, requirement.end)} • {requirement.requiredStaff} staff
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

          <article className="panel review-area">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Review</p>
                <h2>Edit assignments before publishing</h2>
              </div>
              <span className="muted">{selectedPeriod.label}</span>
            </div>
            <div className="print-summary">
              <div>
                <strong>{formatCurrency(reviewedRange.totalCost)}</strong>
                <p className="muted">Projected labor cost for the selected period</p>
              </div>
              <div>
                <strong>{totalAlerts}</strong>
                <p className="muted">Validation and coverage issues</p>
              </div>
            </div>
            <div className="calendar-stack">
              {weekSections.map(({ week, dayCards }) => (
                <section key={week.weekStart.toISOString()} className="week-card">
                  <div className="panel-header compact">
                    <div>
                      <h3>{formatWeekLabel(week.weekStart, week.weekEnd)}</h3>
                      <p className="muted">Tap into any day to see every assigned shift and employee.</p>
                    </div>
                    <span className="status-pill">{formatCurrency(week.schedule.totalCost)}</span>
                  </div>
                  <div className="calendar-grid">
                    {dayCards.map(({ day, requirements, dayAssignments, dayCost }) => (
                      <div key={day} className="day-card">
                        <div className="day-card-header">
                          <strong>{formatDayDate(addDays(week.weekStart, DAYS.indexOf(day)))}</strong>
                          <span className="muted">
                            {dayAssignments.length} shifts • {formatCurrency(dayCost)}
                          </span>
                        </div>
                        {requirements.length ? (
                          <div className="calendar-blocks">
                            {requirements.map(({ requirement, assignments }) => {
                              const missing = Math.max(0, requirement.requiredStaff - assignments.length);
                              const blockDate = assignments[0]?.date ?? isoDateForWeekDay(week.weekStart, requirement.day);
                              const assignmentsBySlot = new Map(assignments.map((assignment) => [assignment.slotIndex, assignment]));
                              return (
                                <div key={requirement.id} className="calendar-block">
                                  <div className="calendar-block-top">
                                    <strong>{formatRange(requirement.start, requirement.end)}</strong>
                                    <span className="status-pill">{requirement.requiredStaff} needed</span>
                                  </div>
                                  <p className="muted">{requirement.role || 'General coverage'}</p>
                                  <div className="assigned-line">
                                    {assignments.length ? (
                                      assignments.map((assignment) => (
                                        <span key={assignment.id} className="assigned-pill">
                                          {assignment.employeeName}
                                        </span>
                                      ))
                                    ) : (
                                      <span className="muted">No one assigned yet</span>
                                    )}
                                  </div>
                                  <div className="review-slots">
                                    {Array.from({ length: requirement.requiredStaff }, (_, slotIndex) => {
                                      const assignment = assignmentsBySlot.get(slotIndex);
                                      const overrideKey = scheduleAssignmentKey({
                                        date: blockDate,
                                        blockId: requirement.id,
                                        slotIndex,
                                      });
                                      const overrideValue = Object.prototype.hasOwnProperty.call(state.scheduleOverrides, overrideKey)
                                        ? state.scheduleOverrides[overrideKey]
                                        : undefined;
                                      const currentValue = overrideValue === null ? '__clear__' : overrideValue ?? assignment?.employeeId ?? '__clear__';
                                      return (
                                        <label key={`${requirement.id}-${slotIndex}`} className="slot-row">
                                          <span>Slot {slotIndex + 1}</span>
                                          <select value={currentValue} onChange={(event) => setScheduleOverride(overrideKey, event.target.value)}>
                                            <option value="__inherit__">Keep generated</option>
                                            <option value="__clear__">Unassigned</option>
                                            {activeEmployees.map((employee) => (
                                              <option key={employee.id} value={employee.id}>
                                                {employee.name}
                                              </option>
                                            ))}
                                          </select>
                                        </label>
                                      );
                                    })}
                                  </div>
                                  {missing > 0 && <p className="warn-line">Unfilled: {missing}</p>}
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <p className="muted">No staffing blocks set for this day.</p>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </article>

          <article className="panel printable-area">
            <PrintableScheduleCalendar
              range={reviewedRange}
              selectedPeriodLabel={selectedPeriod.label}
              totalAlerts={totalAlerts}
            />
          </article>

          <article className="panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Cost summary</p>
                <h2>Labor spend</h2>
              </div>
              <strong className="cost-large">{formatCurrency(reviewedRange.totalCost)}</strong>
            </div>
            <div className="stack">
              {reviewedRange.weeks.map((week) => (
                <div key={week.weekStart.toISOString()} className="day-row">
                  <strong>{formatWeekLabel(week.weekStart, week.weekEnd)}</strong>
                  <span>{formatCurrency(week.schedule.totalCost)}</span>
                </div>
              ))}
            </div>
            <div className="spacer" />
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

          <article className="panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Alerts</p>
                <h2>Validation and conflicts</h2>
              </div>
            </div>
            <ul className="alert-list">
              {scheduleWarnings.length ? (
                scheduleWarnings.map((warning) => <li key={warning}>{warning}</li>)
              ) : (
                <li>No configuration validation issues.</li>
              )}
            </ul>
          </article>
        </section>
      )}

      {activeSection === 'guide' && (
        <UserGuide
          onOpenEmployees={() => goToSection('employees')}
          onOpenAvailability={() => goToSection('availability')}
          onOpenSchedules={() => goToSection('schedules')}
          onOpenDashboard={() => goToSection('dashboard')}
          onOpenDrive={() => setShowDriveMenu(true)}
        />
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

function ActionTile({
  title,
  description,
  buttonLabel,
  href,
  onClick,
}: {
  title: string;
  description: string;
  buttonLabel: string;
  href?: string;
  onClick: () => void;
}) {
  const action = href ? (
    <a className="primary-button" href={href} onClick={onClick}>
      {buttonLabel}
    </a>
  ) : (
    <button className="primary-button" onClick={onClick}>
      {buttonLabel}
    </button>
  );

  return (
    <article className="action-tile">
      <div>
        <p className="eyebrow">{title}</p>
        <p className="action-copy">{description}</p>
      </div>
      {action}
    </article>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
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

function PrintableScheduleCalendar({
  range,
  selectedPeriodLabel,
  totalAlerts,
}: {
  range: GeneratedScheduleRange;
  selectedPeriodLabel: string;
  totalAlerts: number;
}) {
  const firstWeek = range.weeks[0];
  const calendarMonth = firstWeek?.weekStart ?? new Date();
  const gridStart = monthGridStart(calendarMonth);
  const calendarDays = Array.from({ length: 42 }, (_, index) => addDays(gridStart, index));
  const assignmentsByDate = new Map<string, GeneratedScheduleRange['weeks'][number]['schedule']['assignments']>();

  range.weeks.forEach((week) => {
    week.schedule.assignments.forEach((assignment) => {
      const current = assignmentsByDate.get(assignment.date) ?? [];
      current.push(assignment);
      assignmentsByDate.set(assignment.date, current);
    });
  });

  return (
    <div className="month-export">
      <div className="month-export-title">
        <h2>Month-at-a-Glance Schedule</h2>
      </div>
      <div className="month-export-meta">
        <div>
          <span>Month</span>
          <strong>{formatMonthYear(calendarMonth)}</strong>
        </div>
        <strong>{selectedPeriodLabel}</strong>
        <span>{formatCurrency(range.totalCost)} labor cost | {totalAlerts} issue(s)</span>
      </div>
      <div className="month-calendar">
        {['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((day) => (
          <div key={day} className="month-day-name">
            {day}
          </div>
        ))}
        {calendarDays.map((date) => {
          const isoDate = date.toISOString().slice(0, 10);
          const assignments = (assignmentsByDate.get(isoDate) ?? []).sort((a, b) => (parseTime(a.start) ?? 0) - (parseTime(b.start) ?? 0));
          const isCurrentMonth = date.getMonth() === calendarMonth.getMonth();

          return (
            <div key={isoDate} className={isCurrentMonth ? 'month-cell' : 'month-cell muted-month'}>
              <span className="month-date-number">{date.getDate()}</span>
              <div className="month-cell-body">
                {assignments.length ? (
                  assignments.map((assignment) => (
                    <p key={assignment.id}>
                      {formatCalendarShiftLine(assignment.start, assignment.end, assignment.employeeName)}
                    </p>
                  ))
                ) : (
                  <span className="month-empty">&nbsp;</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function UserGuide({
  onOpenEmployees,
  onOpenAvailability,
  onOpenSchedules,
  onOpenDashboard,
  onOpenDrive,
}: {
  onOpenEmployees: () => void;
  onOpenAvailability: () => void;
  onOpenSchedules: () => void;
  onOpenDashboard: () => void;
  onOpenDrive: () => void;
}) {
  return (
    <section className="guide-workspace">
      <div className="workspace-heading">
        <div>
          <p className="eyebrow">User Guide</p>
          <h2>How to build and publish a weekly schedule</h2>
        </div>
      </div>

      <div className="guide-grid">
        <article className="guide-section">
          <span className="guide-number">1</span>
          <div>
            <h3>Add employees</h3>
            <p>
              Open Employees and enter each person&apos;s name, role, hourly wage, preferred hours, maximum hours, and priority level.
              Higher priority employees are considered first when the schedule is generated.
            </p>
            <button className="ghost-button" onClick={onOpenEmployees}>Open Employees</button>
          </div>
        </article>

        <article className="guide-section">
          <span className="guide-number">2</span>
          <div>
            <h3>Enter availability</h3>
            <p>
              Open Availability, choose the employee, choose the period, then add the days and times that person can work. Use unavailable
              hours for recurring conflicts, and use date-specific exceptions for one-time changes.
            </p>
            <button className="ghost-button" onClick={onOpenAvailability}>Open Availability</button>
          </div>
        </article>

        <article className="guide-section">
          <span className="guide-number">3</span>
          <div>
            <h3>Set business needs</h3>
            <p>
              Open Schedules and set the business hours and staffing requirements. A staffing requirement is the number of people needed
              for a specific day and time block.
            </p>
            <button className="ghost-button" onClick={onOpenSchedules}>Open Schedules</button>
          </div>
        </article>

        <article className="guide-section">
          <span className="guide-number">4</span>
          <div>
            <h3>Generate and review</h3>
            <p>
              Tap Generate Schedule. The app checks availability, business hours, employee max hours, and priority. Review every slot in
              the calendar. If needed, use the slot dropdowns to swap an employee or mark a slot unassigned.
            </p>
          </div>
        </article>

        <article className="guide-section">
          <span className="guide-number">5</span>
          <div>
            <h3>Fix alerts before publishing</h3>
            <p>
              If the schedule has conflicts or understaffed blocks, the app will list them in Alerts. Fix the availability, staffing
              requirement, or manual assignment before publishing.
            </p>
            <button className="ghost-button" onClick={onOpenDashboard}>Open Dashboard</button>
          </div>
        </article>

        <article className="guide-section">
          <span className="guide-number">6</span>
          <div>
            <h3>Publish and export</h3>
            <p>
              When the schedule is ready, tap Publish Reviewed Schedule. Then tap Export Whiteboard Calendar PDF to print or save a
              posted team calendar.
            </p>
            <button className="primary-button" onClick={onOpenSchedules}>Open Schedule Export</button>
          </div>
        </article>

        <article className="guide-section wide">
          <span className="guide-number">7</span>
          <div>
            <h3>Back up the schedule</h3>
            <p>
              The app saves to the current browser automatically. Use Google Drive or Export JSON when you want a recovery copy before
              making major changes or before handing the iPad to someone else.
            </p>
            <button className="ghost-button" onClick={onOpenDrive}>Open Google Drive Backup</button>
          </div>
        </article>
      </div>
    </section>
  );
}

function WeekDateStrip({ start, end }: { start: Date; end: Date }) {
  const days: Date[] = [];
  let cursor = new Date(start);
  while (cursor <= end) {
    days.push(new Date(cursor));
    cursor = addDays(cursor, 1);
  }

  return (
    <div className="date-strip">
      {days.map((date) => (
        <div key={date.toISOString()} className="date-chip">
          <span>{date.toLocaleDateString('en-US', { weekday: 'short' })}</span>
          <strong>{date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</strong>
        </div>
      ))}
    </div>
  );
}

function PeriodSelector({
  period,
  setPeriod,
}: {
  period: { mode: PeriodMode; customStart: string; customEnd: string };
  setPeriod: Dispatch<SetStateAction<{ mode: PeriodMode; customStart: string; customEnd: string }>>;
}) {
  return (
    <div className="period-panel">
      <div className="period-buttons">
        {[
          ['thisWeek', 'This week'],
          ['nextWeek', 'Next week'],
          ['twoWeeks', 'Two weeks'],
          ['custom', 'Custom'],
        ].map(([mode, label]) => (
          <button
            key={mode}
            className={period.mode === mode ? 'section-chip active' : 'section-chip'}
            onClick={() => setPeriod((current) => ({ ...current, mode: mode as PeriodMode }))}
          >
            {label}
          </button>
        ))}
      </div>
      {period.mode === 'custom' && (
        <div className="form-inline">
          <Field label="Start">
            <input type="date" value={period.customStart} onChange={(event) => setPeriod((current) => ({ ...current, customStart: event.target.value }))} />
          </Field>
          <Field label="End">
            <input type="date" value={period.customEnd} onChange={(event) => setPeriod((current) => ({ ...current, customEnd: event.target.value }))} />
          </Field>
        </div>
      )}
    </div>
  );
}
