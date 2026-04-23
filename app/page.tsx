"use client";

import { cloneElement, isValidElement, useEffect, useMemo, useState, type Dispatch, type ReactElement, type ReactNode, type SetStateAction } from 'react';
import {
  DAYS,
  addDays,
  dayFullLabel,
  formatTime,
  isoDateForWeekDay,
  scheduleAssignmentKey,
  generateScheduleRange,
  checkScheduleFeasibility,
  canWorkBlock,
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
  type GeneratedSchedule,
  type GeneratedScheduleRange,
  type ShiftTemplate,
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

type Section = 'home' | 'dashboard' | 'employees' | 'availability' | 'setup' | 'schedules' | 'guide';
type PeriodMode = 'thisWeek' | 'nextWeek' | 'twoWeeks' | 'custom';

const SECTION_LABELS: Record<Section, string> = {
  home: 'Home',
  dashboard: 'Week Summary',
  employees: 'People',
  availability: 'Availability',
  setup: 'Shifts',
  schedules: 'Schedule',
  guide: 'Guide',
};

const WORKSPACE_SECTIONS: Section[] = ['home', 'schedules', 'setup', 'availability', 'employees', 'dashboard', 'guide'];

const STORAGE_KEY = 'staffing-board-state-v1';
const BACKUP_KEY = 'staffing-board-state-backup-v1';
const DRIVE_BACKUP_ID_KEY = 'staffing-board-drive-backup-id-v1';
const DRIVE_BACKUP_AT_KEY = 'staffing-board-drive-backup-at-v1';
const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? '';

function createEmployeeDraft(): Employee {
  return {
    id: uuid('emp'),
    name: '',
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
    shiftTemplates: value?.shiftTemplates ?? fallback.shiftTemplates,
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
      start = safeStart;
      end = safeEnd;
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

function formatDayDate(date: Date) {
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

function normalizeSearchValue(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9\s:-]/g, ' ').replace(/\s+/g, ' ').trim();
}

const QUICK_TIME_PRESETS = [
  { label: 'Morning', start: '08:00', end: '12:00' },
  { label: 'Midday', start: '12:00', end: '16:00' },
  { label: 'Afternoon', start: '14:00', end: '18:00' },
  { label: 'Evening', start: '16:00', end: '20:00' },
  { label: 'Full day', start: '08:00', end: '18:00' },
] as const;

const DEFAULT_SHIFT_TEMPLATES: Array<Pick<ShiftTemplate, 'label' | 'start' | 'end' | 'requiredStaff'>> = [
  { label: 'Open', start: '08:00', end: '12:00', requiredStaff: 2 },
  { label: 'Midday', start: '10:00', end: '14:00', requiredStaff: 3 },
  { label: 'Close', start: '14:00', end: '18:00', requiredStaff: 2 },
  { label: 'Full day', start: '08:00', end: '17:00', requiredStaff: 1 },
];

const SURFACE_CARD = 'rounded-[28px] border border-slate-200/80 bg-white/90 shadow-sm';
const SURFACE_CARD_PAD = `${SURFACE_CARD} p-6`;
const SURFACE_TILE = 'rounded-[24px] border border-slate-200/80 bg-white/90 p-5 shadow-sm transition duration-200 hover:-translate-y-1 hover:shadow-xl';
const SURFACE_SOFT = 'rounded-[20px] border border-slate-200 bg-slate-50 p-4 ring-1 ring-slate-200';
const SURFACE_BUTTON = 'inline-flex min-h-12 items-center justify-center rounded-2xl px-5 py-3 text-sm font-semibold shadow-sm transition hover:-translate-y-0.5 hover:shadow-lg focus-visible:ring-2 focus-visible:ring-blue-200 focus-visible:ring-offset-2 focus-visible:ring-offset-white';
const SURFACE_BUTTON_PRIMARY = `${SURFACE_BUTTON} bg-blue-600 text-white hover:bg-blue-500`;
const SURFACE_BUTTON_SECONDARY = `${SURFACE_BUTTON} border border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50`;
const SURFACE_BUTTON_MUTED = `${SURFACE_BUTTON} border border-slate-200 bg-slate-50 text-slate-700 hover:border-blue-200 hover:bg-white`;
const INLINE_CARD = 'rounded-[20px] border border-slate-200 bg-slate-50 p-4 ring-1 ring-slate-200';
const INLINE_CARD_EMPHASIS = 'rounded-[20px] border border-emerald-200 bg-emerald-50 p-4 text-sm leading-6 text-emerald-800';
const INLINE_BUTTON = 'rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 shadow-sm transition hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-lg focus-visible:ring-2 focus-visible:ring-blue-200 focus-visible:ring-offset-2 focus-visible:ring-offset-white';
const INLINE_BUTTON_MUTED = 'rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-700 shadow-sm transition hover:-translate-y-0.5 hover:border-blue-200 hover:bg-white hover:shadow-lg focus-visible:ring-2 focus-visible:ring-blue-200 focus-visible:ring-offset-2 focus-visible:ring-offset-white';
const INLINE_BUTTON_PRIMARY = 'rounded-2xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white shadow-sm transition hover:-translate-y-0.5 hover:bg-blue-500 hover:shadow-lg focus-visible:ring-2 focus-visible:ring-blue-200 focus-visible:ring-offset-2 focus-visible:ring-offset-white';
const INLINE_BUTTON_SUCCESS = 'rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-700 shadow-sm transition hover:-translate-y-0.5 hover:border-emerald-300 hover:bg-emerald-100 hover:shadow-lg focus-visible:ring-2 focus-visible:ring-emerald-200 focus-visible:ring-offset-2 focus-visible:ring-offset-white';
const CHOICE_PILL = 'rounded-full px-4 py-2 text-sm font-semibold transition focus-visible:ring-2 focus-visible:ring-blue-200 focus-visible:ring-offset-2 focus-visible:ring-offset-white';

function sectionHref(section: Section) {
  return `#${section}`;
}

function sectionFromHash() {
  if (typeof window === 'undefined') return 'home' as Section;
  const hash = window.location.hash.replace('#', '') as Section;
  return WORKSPACE_SECTIONS.includes(hash) ? hash : 'home';
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
      dayHours: week.schedule.dayHours[day] ?? 0,
    }));

    return {
      week,
      dayCards,
    };
  });
}

type SearchSuggestion =
  | { id: string; type: 'section'; label: string; detail: string; section: Section }
  | { id: string; type: 'employee'; label: string; detail: string; employeeId: string; section: Section }
  | { id: string; type: 'template'; label: string; detail: string; templateId: string; section: Section }
  | { id: string; type: 'action'; label: string; detail: string; section: Section };

function buildSmartSearchSuggestions(args: {
  query: string;
  employees: Employee[];
  templates: Array<ShiftTemplate>;
}): SearchSuggestion[] {
  const queryValue = normalizeSearchValue(args.query);
  const tokens = queryValue ? queryValue.split(' ') : [];
  const suggestions: SearchSuggestion[] = [];

  const addUnique = (item: SearchSuggestion) => {
    if (!suggestions.some((entry) => entry.id === item.id)) {
      suggestions.push(item);
    }
  };

  const toSectionSuggestion = (section: { id: string; label: string; detail: string; section: Section }) => ({
    ...section,
    type: 'section' as const,
  });

  const sectionLookup: Array<{ id: string; label: string; detail: string; section: Section; keywords: string[] }> = [
    { id: 'section-home', label: 'Home', detail: 'Owner workspace', section: 'home', keywords: ['home', 'dashboard'] },
    { id: 'section-dashboard', label: 'Week Summary', detail: 'Quick totals', section: 'dashboard', keywords: ['dashboard', 'totals', 'summary'] },
    { id: 'section-employees', label: 'People', detail: 'Employee hours and notes', section: 'employees', keywords: ['employee', 'employees', 'people', 'team'] },
    { id: 'section-availability', label: 'Availability', detail: 'Weekly availability', section: 'availability', keywords: ['availability', 'available', 'unavailable', 'time off'] },
    { id: 'section-setup', label: 'Shifts', detail: 'Hours and shift patterns', section: 'setup', keywords: ['setup', 'admin', 'shift', 'template', 'hours'] },
    { id: 'section-schedules', label: 'Schedule', detail: 'Build and review shifts', section: 'schedules', keywords: ['schedule', 'schedules', 'shift', 'publish'] },
    { id: 'section-guide', label: 'Guide', detail: 'Plain-language help', section: 'guide', keywords: ['guide', 'help', 'how to'] },
  ];

  if (!queryValue) {
    sectionLookup.slice(0, 5).forEach((section) => {
      addUnique(toSectionSuggestion(section));
    });
    if (args.templates[0]) {
      addUnique({
        id: `template-${args.templates[0].id}`,
        type: 'template',
        label: `Quick add ${args.templates[0].label}`,
        detail: `${args.templates[0].start} - ${args.templates[0].end}`,
        templateId: args.templates[0].id,
        section: 'setup',
      });
    }
    return suggestions;
  }

  const sectionScore = (keywords: string[]) => {
    const keywordText = keywords.join(' ');
    return Number(keywords.some((keyword) => queryValue.includes(keyword) || keyword.includes(queryValue))) + Number(tokens.some((token) => keywordText.includes(token)));
  };

  sectionLookup
    .map((section) => ({ section, score: sectionScore(section.keywords) }))
    .filter(({ score }) => score > 0 || queryValue.length < 3)
    .sort((a, b) => b.score - a.score)
    .forEach(({ section }) => addUnique(toSectionSuggestion(section)));

  args.employees
    .filter((employee) => normalizeSearchValue(employee.name).includes(queryValue))
    .slice(0, 5)
    .forEach((employee) =>
      addUnique({
        id: `employee-${employee.id}`,
        type: 'employee',
        label: employee.name,
        detail: `${employee.priorityLevel} priority • ${employee.minPreferredWeeklyHours}-${employee.maxAllowedWeeklyHours} hrs`,
        employeeId: employee.id,
        section: queryValue.includes('avail') ? 'availability' : 'employees',
      }),
    );

  args.templates
    .filter((template) => normalizeSearchValue(`${template.label} ${template.start} ${template.end}`).includes(queryValue) || queryValue.includes(normalizeSearchValue(template.label)))
    .slice(0, 5)
    .forEach((template) =>
      addUnique({
        id: `template-${template.id}`,
        type: 'template',
        label: `${template.label} shift`,
        detail: `${template.start} - ${template.end} • ${template.requiredStaff} staff`,
        templateId: template.id,
        section: 'setup',
      }),
    );

  if (queryValue.includes('8') || queryValue.includes('5') || queryValue.includes('open') || queryValue.includes('close') || queryValue.includes('shift')) {
    args.templates.slice(0, 3).forEach((template) =>
      addUnique({
        id: `template-smart-${template.id}`,
        type: 'template',
        label: `Add ${template.start} - ${template.end}`,
        detail: `${template.label} template`,
        templateId: template.id,
        section: 'setup',
      }),
    );
  }

  return suggestions.slice(0, 8);
}

export default function Page() {
  const [state, setState] = useState<AppState>(createSeedState());
  const [loaded, setLoaded] = useState(false);
  const [activeSection, setActiveSection] = useState<Section>('home');
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string>('');
  const [selectedScheduleEmployeeId, setSelectedScheduleEmployeeId] = useState<string>('');
  const [selectedScheduleAssignmentId, setSelectedScheduleAssignmentId] = useState<string>('');
  const [draggedAssignmentId, setDraggedAssignmentId] = useState<string>('');
  const [employeeDraft, setEmployeeDraft] = useState<Employee>(createEmployeeDraft());
  const [period, setPeriod] = useState(createPeriodDraft());
  const [storageStatus, setStorageStatus] = useState<'loading' | 'saved'>('loading');
  const [driveStatus, setDriveStatus] = useState<'idle' | 'connecting' | 'backing up' | 'restoring' | 'ready' | 'error'>('idle');
  const [driveMessage, setDriveMessage] = useState('Drive backup is optional.');
  const [driveAccessToken, setDriveAccessToken] = useState<string | null>(null);
  const [driveBackupFileId, setDriveBackupFileId] = useState<string | null>(null);
  const [driveBackupAt, setDriveBackupAt] = useState<string | null>(null);
  const [showDriveMenu, setShowDriveMenu] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  const [lastGeneratedAt, setLastGeneratedAt] = useState<string | null>(null);
  const [rangeDraft, setRangeDraft] = useState({ day: 'mon' as DayKey, start: '09:00', end: '17:00' });
  const [businessHoursDraft, setBusinessHoursDraft] = useState({ day: 'mon' as DayKey, start: '08:00', end: '18:00' });
  const [templateDraft, setTemplateDraft] = useState({
    label: 'Open',
    start: '08:00',
    end: '12:00',
    requiredStaff: 2,
    notes: '',
  });
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [requirementDraft, setRequirementDraft] = useState({
    day: 'mon' as DayKey,
    start: '09:00',
    end: '12:00',
    requiredStaff: 2,
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
    if (!selectedScheduleEmployeeId && state.employees[0]) {
      setSelectedScheduleEmployeeId(state.employees[0].id);
    }
  }, [selectedScheduleEmployeeId, state.employees]);

  useEffect(() => {
    if (!state.employees.find((employee) => employee.id === selectedEmployeeId)) return;
    const employee = state.employees.find((entry) => entry.id === selectedEmployeeId);
    if (employee) setEmployeeDraft(employee);
  }, [selectedEmployeeId, state.employees]);

  useEffect(() => {
    if (process.env.NODE_ENV === 'production' && 'serviceWorker' in navigator) {
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
  const activeShiftTemplates: ShiftTemplate[] = state.shiftTemplates.length
    ? state.shiftTemplates
    : DEFAULT_SHIFT_TEMPLATES.map((template, index) => ({
        id: `template-${index}`,
        ...template,
      }));
  const scheduleWeek = reviewedRange.weeks[0];
  const scheduleAssignments = scheduleWeek?.schedule.assignments ?? [];
  const scheduleDaySummaries = scheduleWeek?.schedule.daySummaries ?? DAYS.reduce(
    (acc, day) => {
      acc[day] = { totalRequired: 0, totalAssigned: 0, blocks: [] };
      return acc;
    },
    {} as GeneratedSchedule['daySummaries'],
  );
  const selectedScheduleAssignment =
    scheduleAssignments.find((assignment) => assignment.id === selectedScheduleAssignmentId) ?? scheduleAssignments[0] ?? null;
  const selectedScheduleEmployee =
    state.employees.find((employee) => employee.id === selectedScheduleEmployeeId) ??
    state.employees.find((employee) => employee.id === selectedScheduleAssignment?.employeeId) ??
    activeEmployees[0] ??
    state.employees[0] ??
    null;
  const totalAssignedHours = reviewedRange.totalHours;
  const totalAlerts = validationMessages.length + reviewedRange.alerts.length;
  const underfilledCount = reviewedRange.alerts.filter((alert) => alert.kind === 'understaffed').length;
  const searchSuggestions = useMemo(
    () =>
      buildSmartSearchSuggestions({
        query: searchQuery,
        employees: state.employees,
        templates: activeShiftTemplates,
      }),
    [activeShiftTemplates, searchQuery, state.employees],
  );

  if (!loaded) {
    return (
      <main className="shell app-shell loading-shell" aria-busy="true" aria-live="polite">
        <aside className="sidebar loading-sidebar">
          <div className="skeleton-stack">
            <div className="skeleton-line skeleton-line-lg" />
            <div className="skeleton-line skeleton-line-md" />
          </div>
          <div className="loading-nav">
            <div className="skeleton-chip" />
            <div className="skeleton-chip" />
            <div className="skeleton-chip" />
            <div className="skeleton-chip" />
          </div>
        </aside>
        <section className="app-main loading-main">
          <div className="topbar loading-topbar">
            <div className="skeleton-stack">
              <div className="skeleton-line skeleton-line-xl" />
              <div className="skeleton-line skeleton-line-sm" />
            </div>
            <div className="skeleton-actions">
              <div className="skeleton-pill" />
              <div className="skeleton-pill" />
              <div className="skeleton-pill" />
            </div>
          </div>
          <section className="summary-strip">
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="metric skeleton-card">
                <div className="skeleton-line skeleton-line-sm" />
                <div className="skeleton-line skeleton-line-xl" />
              </div>
            ))}
          </section>
          <section className="panel-grid two-up">
            <div className="panel skeleton-card" />
            <div className="panel skeleton-card" />
          </section>
        </section>
      </main>
    );
  }

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

  function removeAvailabilityRule(type: 'weeklyAvailability', id: string) {
    if (!selectedEmployee) return;
    persistNextState({
      ...state,
      availability: updateAvailabilityMap(state.availability, selectedEmployee.id, (entry) => ({
        ...entry,
        weeklyAvailability:
          type === 'weeklyAvailability'
            ? entry.weeklyAvailability.filter((item, index) => `${item.day}-${index}` !== id)
            : entry.weeklyAvailability,
        weeklyUnavailability: entry.weeklyUnavailability,
        exceptions: entry.exceptions,
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

  function saveShiftTemplate() {
    if (!templateDraft.label.trim() || !templateDraft.start || !templateDraft.end || templateDraft.requiredStaff < 1) return;
    const nextTemplate = {
      id: editingTemplateId ?? uuid('tpl'),
      label: templateDraft.label.trim(),
      start: templateDraft.start,
      end: templateDraft.end,
      requiredStaff: templateDraft.requiredStaff,
      notes: templateDraft.notes.trim(),
    };
    persistNextState({
      ...state,
      shiftTemplates: editingTemplateId
        ? state.shiftTemplates.map((template) => (template.id === editingTemplateId ? nextTemplate : template))
        : [...state.shiftTemplates, nextTemplate],
    });
    setEditingTemplateId(null);
    setTemplateDraft({
      label: 'Open',
      start: '08:00',
      end: '12:00',
      requiredStaff: 2,
      notes: '',
    });
  }

  function editShiftTemplate(templateId: string) {
    const template = state.shiftTemplates.find((entry) => entry.id === templateId);
    if (!template) return;
    setEditingTemplateId(template.id);
    setTemplateDraft({
      label: template.label,
      start: template.start,
      end: template.end,
      requiredStaff: template.requiredStaff,
      notes: template.notes ?? '',
    });
    goToSection('setup');
  }

  function deleteShiftTemplate(templateId: string) {
    persistNextState({
      ...state,
      shiftTemplates: state.shiftTemplates.filter((template) => template.id !== templateId),
    });
    if (editingTemplateId === templateId) {
      setEditingTemplateId(null);
      setTemplateDraft({
        label: 'Open',
        start: '08:00',
        end: '12:00',
        requiredStaff: 2,
        notes: '',
      });
    }
  }

  function deleteBusinessHours(day: DayKey, index: number) {
    persistNextState({
      ...state,
      businessHours: state.businessHours.map((entry) =>
        entry.day === day ? { ...entry, ranges: entry.ranges.filter((_, rangeIndex) => rangeIndex !== index) } : entry,
      ),
    });
  }

  function addRequirementFromTemplate(template: ShiftTemplate) {
    if (!requirementDraft.day) return;
    persistNextState({
      ...state,
      staffingRequirements: [
        ...state.staffingRequirements,
        {
          id: uuid('req'),
          day: requirementDraft.day,
          start: template.start,
          end: template.end,
          requiredStaff: template.requiredStaff,
          notes: template.notes ?? template.label,
        },
      ].sort((a, b) => DAYS.indexOf(a.day) - DAYS.indexOf(b.day) || (parseTime(a.start) ?? 0) - (parseTime(b.start) ?? 0)),
    });
    goToSection('schedules');
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

  function openEmployee(employeeId: string, section: Section = 'employees') {
    setSelectedEmployeeId(employeeId);
    goToSection(section);
    setSearchQuery('');
    setSearchFocused(false);
  }

  function selectSearchSuggestion(suggestion: SearchSuggestion) {
    if (suggestion.type === 'section') {
      goToSection(suggestion.section);
    } else if (suggestion.type === 'employee') {
      openEmployee(suggestion.employeeId, suggestion.section);
    } else if (suggestion.type === 'template') {
      const template = activeShiftTemplates.find((entry) => entry.id === suggestion.templateId);
      if (template) {
        setTemplateDraft({
          label: template.label,
          start: template.start,
          end: template.end,
          requiredStaff: template.requiredStaff,
          notes: template.notes ?? '',
        });
      }
      goToSection(suggestion.section);
    } else {
      goToSection(suggestion.section);
    }
    setSearchQuery('');
    setSearchFocused(false);
  }

  function refreshSchedule() {
    setLastGeneratedAt(new Date().toISOString());
  }

  function saveScheduleDraft() {
    persistNextState(state);
  }

  function autoOptimizeSchedule() {
    refreshSchedule();
  }

  function openScheduleCenter() {
    goToSection('schedules');
  }

  function buildScheduleNow() {
    refreshSchedule();
    goToSection('schedules');
  }

  function copyLastWeek() {
    const anchor = weekStartMonday(selectedPeriod.start);
    const previousWeekStart = addDays(anchor, -7);
    setPeriod({
      mode: 'custom',
      customStart: previousWeekStart.toISOString().slice(0, 10),
      customEnd: addDays(previousWeekStart, 6).toISOString().slice(0, 10),
    });
    goToSection('schedules');
  }

  function shiftScheduleWeek(offset: number) {
    const anchor = weekStartMonday(selectedPeriod.start);
    const shiftedStart = addDays(anchor, offset * 7);
    setPeriod({
      mode: 'custom',
      customStart: shiftedStart.toISOString().slice(0, 10),
      customEnd: addDays(shiftedStart, 6).toISOString().slice(0, 10),
    });
  }

  function jumpToScheduleDay(day: DayKey) {
    setRequirementDraft((current) => ({ ...current, day }));
    if (typeof document !== 'undefined') {
      window.setTimeout(() => {
        document.getElementById('schedule-quick-add')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 0);
    }
  }

  function selectScheduleEmployee(employeeId: string) {
    setSelectedScheduleEmployeeId(employeeId);
    setSelectedScheduleAssignmentId('');
  }

  function selectScheduleAssignment(assignmentId: string, employeeId: string) {
    setSelectedScheduleAssignmentId(assignmentId);
    setSelectedScheduleEmployeeId(employeeId);
  }

  function setDraggedScheduleAssignment(assignmentId: string) {
    setDraggedAssignmentId(assignmentId);
  }

  function moveDraggedAssignmentToEmployee(targetEmployeeId: string) {
    if (!draggedAssignmentId) return;
    const assignment = scheduleAssignments.find((entry) => entry.id === draggedAssignmentId);
    if (!assignment) return;
    setScheduleOverride(
      scheduleAssignmentKey({
        date: assignment.date,
        blockId: assignment.blockId,
        slotIndex: assignment.slotIndex,
      }),
      targetEmployeeId,
    );
    setDraggedAssignmentId('');
  }

  const currentWeekHours = reviewedRange.totalHours;
  const openShiftCount = reviewedRange.alerts.filter((alert) => alert.kind === 'understaffed').length;
  const conflictCount = validationMessages.length + reviewedRange.alerts.filter((alert) => alert.kind === 'validation').length;
  const overtimeRiskEmployees = activeEmployees.filter((employee) => {
    const hours = reviewedRange.employeeHours[employee.id] ?? 0;
    return hours > employee.maxAllowedWeeklyHours * 0.85;
  });
  const overtimeRiskCount = overtimeRiskEmployees.length;
  const activeAvailabilityCount = state.employees.filter((employee) => (state.availability[employee.id]?.weeklyAvailability.length ?? 0) > 0).length;
  const weekHealthTone = openShiftCount || conflictCount || overtimeRiskCount ? 'warn' : 'good';
  const weekHealthLabel = openShiftCount || conflictCount || overtimeRiskCount ? 'Needs attention' : 'Healthy week';
  const storageLabel = storageStatus === 'saved' ? 'Saved' : 'Saving';
  const saveDescriptor = state.schedulePublishedAt
    ? `Published ${new Date(state.schedulePublishedAt).toLocaleString()}`
    : `Auto-saved locally ${new Date(state.updatedAt).toLocaleString()}`;
  const availabilityPreview = state.employees
    .filter((employee) => (state.availability[employee.id]?.weeklyAvailability.length ?? 0) > 0)
    .slice(0, 3)
    .map((employee) => ({
      id: employee.id,
      name: employee.name,
      blocks: state.availability[employee.id]?.weeklyAvailability.length ?? 0,
    }));
  const shortcutItems: Array<{
    title: string;
    description: string;
    cta: string;
    section: Section;
    icon: 'schedule' | 'availability' | 'setup' | 'employees' | 'dashboard' | 'guide';
  }> = [
    {
      title: 'Schedule',
      description: 'Build, review, publish, and export the week.',
      cta: 'Open schedule',
      section: 'schedules',
      icon: 'schedule',
    },
    {
      title: 'Availability',
      description: 'Set weekly hours for each employee.',
      cta: 'View availability',
      section: 'availability',
      icon: 'availability',
    },
    {
      title: 'Shifts',
      description: 'Define hours of operation and shift templates.',
      cta: 'Open shifts',
      section: 'setup',
      icon: 'setup',
    },
    {
      title: 'People',
      description: 'Manage names, limits, and priority.',
      cta: 'Open people',
      section: 'employees',
      icon: 'employees',
    },
    {
      title: 'Week Summary',
      description: 'See the week at a glance and track save status.',
      cta: 'Open summary',
      section: 'dashboard',
      icon: 'dashboard',
    },
    {
      title: 'Guide',
      description: 'Read the plain-language walkthrough.',
      cta: 'Open guide',
      section: 'guide',
      icon: 'guide',
    },
  ];
  const homeAlerts = [
    ...reviewedRange.alerts.slice(0, 3).map((alert) => ({
      key: alert.id,
      label: alert.message,
      tone: alert.kind === 'understaffed' ? 'amber' : alert.kind === 'hours' ? 'blue' : 'slate',
    })),
    ...(validationMessages.length
      ? validationMessages.slice(0, 2).map((message, index) => ({
          key: `validation-${index}`,
          label: message,
          tone: 'amber',
        }))
      : []),
  ];

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
  }));

  const scheduleWarnings = [...validationMessages, ...reviewedRange.alerts.map((warning) => warning.message)];

  return (
    <main className="shell app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <p className="eyebrow">Staffing Board</p>
          <h1>Staffing Board</h1>
          <p className="sync-line">
            Storage: <strong>{storageStatus}</strong>
          </p>
        </div>

        <nav className="sidebar-nav" aria-label="Sections">
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

        <div className="sidebar-footer">
          <button className="ghost-button" type="button" onClick={() => setShowDriveMenu(true)}>
            Google Drive
          </button>
          <button className="ghost-button" type="button" onClick={clearAllData}>
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
          <p className="sync-line" aria-live="polite">
            {activePeriodLabel}
          </p>
        </div>
      </aside>

      <div className="app-main">
        <header className="topbar">
          <div className="topbar-copy">
            <p className="eyebrow">Business workspace</p>
            <h1>Staffing Board</h1>
            <p className="sync-line">Tablet-first scheduling for small teams.</p>
          </div>
          <div className="topbar-actions">
            <div className="topbar-search-wrap">
              <label className="topbar-search" htmlFor="owner-search">
                <span className="sr-only">Search</span>
                <input
                  id="owner-search"
                  name="search"
                  type="search"
                  placeholder="Search employees, setup, shifts…"
                  value={searchQuery}
                  autoComplete="off"
                  spellCheck={false}
                  aria-haspopup="listbox"
                  aria-expanded={Boolean(searchFocused && (searchQuery.trim() || searchSuggestions.length > 0))}
                  aria-controls="owner-search-results"
                  onChange={(event) => {
                    setSearchQuery(event.target.value);
                    setSearchFocused(true);
                  }}
                  onFocus={() => setSearchFocused(true)}
                  onBlur={() => window.setTimeout(() => setSearchFocused(false), 120)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      setSearchQuery('');
                      setSearchFocused(false);
                    }
                    if (event.key === 'Enter' && searchSuggestions[0]) {
                      event.preventDefault();
                      selectSearchSuggestion(searchSuggestions[0]);
                    }
                  }}
                />
              </label>
              {searchFocused && (searchQuery.trim() || searchSuggestions.length > 0) && (
                <div className="search-dropdown panel" id="owner-search-results" role="listbox" aria-label="Search suggestions">
                  {searchSuggestions.length ? (
                    searchSuggestions.map((suggestion) => (
                      <button
                        key={suggestion.id}
                        className="search-result"
                        type="button"
                        role="option"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => selectSearchSuggestion(suggestion)}
                      >
                        <span>
                          <strong>{suggestion.label}</strong>
                          <small>{suggestion.detail}</small>
                        </span>
                        <span className="status-pill">{SECTION_LABELS[suggestion.section]}</span>
                      </button>
                    ))
                  ) : (
                    <p className="muted">No matches yet. Try an employee name, setup, or a shift time like 8 to 5.</p>
                  )}
                </div>
              )}
            </div>
            <span className="topbar-badge" aria-label="Selected period">
              {activePeriodLabel}
            </span>
            <button className="ghost-button" type="button" aria-label="Notifications">
              Notifications
            </button>
            <button className="ghost-button" type="button" aria-label="User menu" onClick={() => setShowUserMenu((current) => !current)}>
              JD
            </button>
          </div>
        </header>

        {showUserMenu && (
          <div className="drive-overlay" role="presentation" onClick={() => setShowUserMenu(false)}>
            <aside className="drive-menu panel" role="dialog" aria-modal="true" aria-label="User menu" onClick={(event) => event.stopPropagation()}>
              <div className="panel-header">
                <div>
                  <p className="eyebrow">Account</p>
                  <h2>Owner menu</h2>
                </div>
                <button className="ghost-button small" type="button" onClick={() => setShowUserMenu(false)}>
                  Close
                </button>
              </div>
              <div className="backup-actions">
                <button className="ghost-button" type="button" onClick={() => goToSection('dashboard')}>
                  Open week summary
                </button>
                <button className="ghost-button" type="button" onClick={() => goToSection('guide')}>
                  Open guide
                </button>
                <button className="ghost-button" type="button" onClick={() => setShowDriveMenu(true)}>
                  Google Drive backup
                </button>
              </div>
            </aside>
          </div>
        )}

        {showDriveMenu && (
        <div className="drive-overlay" role="presentation" onClick={() => setShowDriveMenu(false)}>
          <aside className="drive-menu panel" role="dialog" aria-modal="true" aria-label="Google Drive menu" onClick={(event) => event.stopPropagation()}>
            <div className="panel-header">
              <div>
                <p className="eyebrow">Google Drive</p>
                <h2>Backup and restore</h2>
              </div>
              <button className="ghost-button small" type="button" onClick={() => setShowDriveMenu(false)}>
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
            <p className="sync-line" aria-live="polite">
              Status: <strong>{driveStatus}</strong> {driveBackupAt ? `• Last backup ${new Date(driveBackupAt).toLocaleString()}` : ''}
            </p>
            <p className="sync-line" aria-live="polite">
              {driveMessage}
            </p>
            <div className="backup-actions">
              <button className="ghost-button" type="button" onClick={connectDrive} disabled={!GOOGLE_CLIENT_ID}>
                {driveAccessToken ? 'Reconnect Drive' : 'Connect Google Drive'}
              </button>
              <button className="primary-button" type="button" onClick={backUpToDrive} disabled={!GOOGLE_CLIENT_ID}>
                Back up now
              </button>
              <button className="ghost-button" type="button" onClick={restoreFromDrive} disabled={!GOOGLE_CLIENT_ID}>
                Restore latest
              </button>
              <button className="ghost-button" type="button" onClick={exportState}>
                Export JSON
              </button>
            </div>
          </aside>
        </div>
        )}

        {activeSection === 'home' && (
          <section className="space-y-6">
            <div className={SURFACE_CARD}>
              <div className="grid gap-6 p-6 lg:grid-cols-[minmax(0,1.15fr)_360px] lg:p-8">
                <div className="space-y-5">
                  <div className="inline-flex items-center rounded-full border border-blue-100 bg-blue-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.24em] text-blue-700">
                    Current week
                  </div>
                  <div className="space-y-3">
                    <h2 className="text-4xl font-semibold tracking-tight text-slate-950 md:text-5xl">Staffing Board</h2>
                    <p className="max-w-2xl text-base leading-7 text-slate-600 md:text-lg">
                      {selectedPeriod.label} is the work week in view. {openShiftCount} open shift{openShiftCount === 1 ? '' : 's'}, {conflictCount}{' '}
                      conflict{conflictCount === 1 ? '' : 's'}, and {overtimeRiskCount} employee{overtimeRiskCount === 1 ? '' : 's'} near overtime.
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-3">
                    <button className={SURFACE_BUTTON_PRIMARY} type="button" onClick={openScheduleCenter}>
                      Open Schedule
                    </button>
                    <button className={SURFACE_BUTTON_SECONDARY} type="button" onClick={copyLastWeek}>
                      Copy Last Week
                    </button>
                    <button className={SURFACE_BUTTON_MUTED} type="button" onClick={buildScheduleNow}>
                      Build Schedule
                    </button>
                  </div>
                </div>

                <div className={SURFACE_SOFT}>
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">Week picker</p>
                      <p className="mt-2 text-sm font-semibold text-slate-950">{selectedPeriod.label}</p>
                    </div>
                    <span
                      className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold ${
                        weekHealthTone === 'good' ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200' : 'bg-amber-50 text-amber-700 ring-1 ring-amber-200'
                      }`}
                    >
                      {weekHealthLabel}
                    </span>
                  </div>
                  <div className="mt-4">
                    <PeriodSelector period={period} setPeriod={setPeriod} />
                  </div>
                  <div className={`mt-5 grid gap-3 ${INLINE_CARD}`}>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-medium text-slate-500">Current week</span>
                      <span className="text-sm font-semibold text-slate-900">{activePeriodLabel}</span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-medium text-slate-500">Save state</span>
                      <span className="text-sm font-semibold text-slate-900">{storageLabel}</span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-medium text-slate-500">Published to team</span>
                      <span className="text-sm font-semibold text-slate-900">{state.schedulePublishedAt ? 'Yes' : 'Not yet'}</span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-medium text-slate-500">Availability</span>
                      <span className="text-sm font-semibold text-slate-900">
                        {activeAvailabilityCount}/{state.employees.length} employees set
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
              {[
                {
                  label: 'Scheduled Hours',
                  value: `${currentWeekHours.toFixed(1)} hrs`,
                  detail: `${reviewedRange.weeks.length} week${reviewedRange.weeks.length === 1 ? '' : 's'} in view`,
                  tone: 'blue',
                },
                {
                  label: 'Open Shifts',
                  value: `${openShiftCount}`,
                  detail: openShiftCount ? 'Needs staffing attention' : 'All covered right now',
                  tone: openShiftCount ? 'amber' : 'emerald',
                },
                {
                  label: 'Conflicts',
                  value: `${conflictCount}`,
                  detail: conflictCount ? 'Review availability and rules' : 'No blocking issues',
                  tone: conflictCount ? 'amber' : 'emerald',
                },
                {
                  label: 'Overtime Risk',
                  value: `${overtimeRiskCount}`,
                  detail: overtimeRiskCount ? 'Employees nearing max hours' : 'No one near max hours',
                  tone: overtimeRiskCount ? 'amber' : 'emerald',
                },
                {
                  label: 'Labor Cost',
                  value: 'Not tracked',
                  detail: 'Hours-only planning mode',
                  tone: 'slate',
                },
              ].map((item) => (
                <article key={item.label} className={`group ${SURFACE_TILE}`}>
                  <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">{item.label}</p>
                  <div className="mt-3 flex items-end justify-between gap-4">
                    <strong className="text-2xl font-semibold tracking-tight text-slate-950">{item.value}</strong>
                    <span
                      className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${
                        item.tone === 'emerald'
                          ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200'
                          : item.tone === 'amber'
                          ? 'bg-amber-50 text-amber-700 ring-1 ring-amber-200'
                          : item.tone === 'blue'
                          ? 'bg-blue-50 text-blue-700 ring-1 ring-blue-200'
                          : 'bg-slate-100 text-slate-600 ring-1 ring-slate-200'
                      }`}
                    >
                      {item.tone === 'emerald' ? 'Good' : item.tone === 'amber' ? 'Watch' : item.tone === 'blue' ? 'Live' : 'Mode'}
                    </span>
                  </div>
                  <p className="mt-3 text-sm leading-6 text-slate-500">{item.detail}</p>
                </article>
              ))}
            </section>

            <section className="grid gap-6 xl:grid-cols-2">
              <div className="space-y-6">
                <article className={SURFACE_CARD_PAD}>
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">Week status</p>
                      <h3 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">{weekHealthLabel}</h3>
                    </div>
                    <button className="text-sm font-semibold text-blue-700 transition hover:text-blue-600 focus-visible:ring-2 focus-visible:ring-blue-200 focus-visible:ring-offset-2 focus-visible:ring-offset-white" type="button" onClick={openScheduleCenter}>
                      Open Schedule
                    </button>
                  </div>
                  <div className="mt-5 grid gap-3 sm:grid-cols-2">
                    <div className={INLINE_CARD}>
                      <p className="text-sm font-medium text-slate-500">Current week</p>
                      <p className="mt-1 text-base font-semibold text-slate-950">{activePeriodLabel}</p>
                    </div>
                    <div className={INLINE_CARD}>
                      <p className="text-sm font-medium text-slate-500">Coverage</p>
                      <p className="mt-1 text-base font-semibold text-slate-950">{currentWeekHours.toFixed(1)} scheduled hours</p>
                    </div>
                    <div className={INLINE_CARD}>
                      <p className="text-sm font-medium text-slate-500">Active employees</p>
                      <p className="mt-1 text-base font-semibold text-slate-950">{activeCount}</p>
                    </div>
                    <div className={INLINE_CARD}>
                    <p className="text-sm font-medium text-slate-500">Availability ready</p>
                    <p className="mt-1 text-base font-semibold text-slate-950">{activeAvailabilityCount} people</p>
                    </div>
                  </div>
                </article>

                <article className={SURFACE_CARD_PAD}>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">Alerts</p>
                    <h3 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">What needs attention</h3>
                  </div>
                  <div className="mt-5 space-y-3">
                    {homeAlerts.length ? (
                      homeAlerts.map((alert) => (
                        <div key={alert.key} className={INLINE_CARD}>
                          <div className="flex items-start gap-3">
                            <span
                              className={`mt-0.5 inline-flex h-3 w-3 shrink-0 rounded-full ${
                                alert.tone === 'amber' ? 'bg-amber-500' : alert.tone === 'blue' ? 'bg-blue-500' : 'bg-slate-400'
                              }`}
                            />
                            <p className="text-sm leading-6 text-slate-700">{alert.label}</p>
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className={INLINE_CARD_EMPHASIS}>
                        No blocking alerts. The week is in good shape.
                      </div>
                    )}
                  </div>
                </article>

                <article className={SURFACE_CARD_PAD}>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">Upcoming actions</p>
                    <h3 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">What to do next</h3>
                  </div>
                  <ul className="mt-5 space-y-3">
                    <li className="flex items-start gap-3 rounded-[20px] bg-slate-50 p-4 ring-1 ring-slate-200">
                      <span className="mt-1 h-2.5 w-2.5 rounded-full bg-blue-500" />
                      <span className="text-sm leading-6 text-slate-700">
                        {openShiftCount ? `Fill ${openShiftCount} open shift${openShiftCount === 1 ? '' : 's'} before publishing.` : 'Open the schedule to review the week.'}
                      </span>
                    </li>
                    <li className="flex items-start gap-3 rounded-[20px] bg-slate-50 p-4 ring-1 ring-slate-200">
                      <span className="mt-1 h-2.5 w-2.5 rounded-full bg-amber-500" />
                      <span className="text-sm leading-6 text-slate-700">
                        {overtimeRiskCount
                          ? `${overtimeRiskCount} employee${overtimeRiskCount === 1 ? '' : 's'} are near their maximum hours.`
                          : 'Hours look balanced across the team.'}
                      </span>
                    </li>
                    <li className="flex items-start gap-3 rounded-[20px] bg-slate-50 p-4 ring-1 ring-slate-200">
                      <span className="mt-1 h-2.5 w-2.5 rounded-full bg-emerald-500" />
                      <span className="text-sm leading-6 text-slate-700">
                        Use the calendar export once the week is ready for the whiteboard.
                      </span>
                    </li>
                  </ul>
                </article>
              </div>

              <div className="space-y-6">
                <article className={SURFACE_CARD_PAD}>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">Quick actions</p>
                    <h3 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">Fast owner controls</h3>
                  </div>
                  <div className="mt-5 grid gap-3">
                    <button className="flex items-center justify-between rounded-[20px] border border-slate-200 bg-slate-50 px-4 py-4 text-left text-sm font-semibold text-slate-800 transition hover:-translate-y-0.5 hover:border-blue-200 hover:bg-white hover:shadow-lg focus-visible:ring-2 focus-visible:ring-blue-200 focus-visible:ring-offset-2 focus-visible:ring-offset-white" type="button" onClick={openScheduleCenter}>
                      <span>Open schedule</span>
                      <span className="text-blue-600">→</span>
                    </button>
                    <button className="flex items-center justify-between rounded-[20px] border border-slate-200 bg-slate-50 px-4 py-4 text-left text-sm font-semibold text-slate-800 transition hover:-translate-y-0.5 hover:border-blue-200 hover:bg-white hover:shadow-lg focus-visible:ring-2 focus-visible:ring-blue-200 focus-visible:ring-offset-2 focus-visible:ring-offset-white" type="button" onClick={buildScheduleNow}>
                      <span>Build schedule</span>
                      <span className="text-blue-600">→</span>
                    </button>
                    <button className="flex items-center justify-between rounded-[20px] border border-slate-200 bg-slate-50 px-4 py-4 text-left text-sm font-semibold text-slate-800 transition hover:-translate-y-0.5 hover:border-blue-200 hover:bg-white hover:shadow-lg focus-visible:ring-2 focus-visible:ring-blue-200 focus-visible:ring-offset-2 focus-visible:ring-offset-white" type="button" onClick={() => goToSection('availability')}>
                      <span>View availability</span>
                      <span className="text-blue-600">→</span>
                    </button>
                    <button className="flex items-center justify-between rounded-[20px] border border-slate-200 bg-slate-50 px-4 py-4 text-left text-sm font-semibold text-slate-800 transition hover:-translate-y-0.5 hover:border-blue-200 hover:bg-white hover:shadow-lg focus-visible:ring-2 focus-visible:ring-blue-200 focus-visible:ring-offset-2 focus-visible:ring-offset-white" type="button" onClick={() => setShowDriveMenu(true)}>
                      <span>Back up to Google Drive</span>
                      <span className="text-blue-600">→</span>
                    </button>
                  </div>
                </article>

                <article className={SURFACE_CARD_PAD}>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">Availability changes</p>
                    <h3 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">Who can work this week</h3>
                  </div>
                  <div className="mt-5 space-y-3">
                    {availabilityPreview.length ? (
                      availabilityPreview.map((employee) => (
                        <div key={employee.id} className="flex items-center justify-between rounded-[20px] bg-slate-50 px-4 py-4 ring-1 ring-slate-200">
                          <div>
                            <p className="text-sm font-semibold text-slate-900">{employee.name}</p>
                            <p className="text-sm text-slate-500">{employee.blocks} weekly block{employee.blocks === 1 ? '' : 's'}</p>
                          </div>
                          <span className="inline-flex rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-200">
                            Ready
                          </span>
                        </div>
                      ))
                    ) : (
                      <div className="rounded-[20px] border border-slate-200 bg-slate-50 p-4 text-sm leading-6 text-slate-600">
                        No weekly availability has been entered yet.
                      </div>
                    )}
                  </div>
                </article>

                <article className={SURFACE_CARD_PAD}>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">Recent status</p>
                    <h3 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">Saved and published</h3>
                  </div>
                  <div className="mt-5 grid gap-3">
                    <div className="flex items-center justify-between rounded-[20px] bg-slate-50 px-4 py-4 ring-1 ring-slate-200">
                      <span className="text-sm font-medium text-slate-500">Saved here</span>
                      <span className="text-sm font-semibold text-slate-900">{storageLabel}</span>
                    </div>
                    <div className="flex items-center justify-between rounded-[20px] bg-slate-50 px-4 py-4 ring-1 ring-slate-200">
                      <span className="text-sm font-medium text-slate-500">Auto-save</span>
                      <span className="text-sm font-semibold text-slate-900">Always on</span>
                    </div>
                    <div className="flex items-center justify-between rounded-[20px] bg-slate-50 px-4 py-4 ring-1 ring-slate-200">
                      <span className="text-sm font-medium text-slate-500">Last saved</span>
                      <span className="text-sm font-semibold text-slate-900">{new Date(state.updatedAt).toLocaleString()}</span>
                    </div>
                    <div className="flex items-center justify-between rounded-[20px] bg-slate-50 px-4 py-4 ring-1 ring-slate-200">
                      <span className="text-sm font-medium text-slate-500">Published to team</span>
                      <span className="text-sm font-semibold text-slate-900">{state.schedulePublishedAt ? new Date(state.schedulePublishedAt).toLocaleString() : 'Not yet published'}</span>
                    </div>
                    <div className="flex items-center justify-between rounded-[20px] bg-slate-50 px-4 py-4 ring-1 ring-slate-200">
                      <span className="text-sm font-medium text-slate-500">Drive backup</span>
                      <span className="text-sm font-semibold text-slate-900">{driveBackupAt ? new Date(driveBackupAt).toLocaleString() : 'Not backed up'}</span>
                    </div>
                  </div>
                </article>
              </div>
            </section>

            <section className="space-y-4">
              <div className="flex items-end justify-between gap-4">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">Workspace shortcuts</p>
                  <h3 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">Jump to the next task</h3>
                </div>
                <span className="hidden text-sm font-medium text-slate-500 md:block">{selectedPeriod.label}</span>
              </div>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {shortcutItems.map((item) => (
                  <button
                    key={item.section}
                    className="group rounded-[24px] border border-slate-200/80 bg-white/90 p-5 text-left shadow-sm transition duration-200 hover:-translate-y-1 hover:border-blue-200 hover:shadow-xl"
                    onClick={() => goToSection(item.section)}
                  >
                    <div className="flex items-start gap-4">
                      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-slate-100 text-blue-600 transition group-hover:bg-blue-50">
                        <SectionGlyph kind={item.icon} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-lg font-semibold tracking-tight text-slate-950">{item.title}</p>
                        <p className="mt-2 text-sm leading-6 text-slate-500">{item.description}</p>
                        <span className="mt-4 inline-flex items-center text-sm font-semibold text-blue-700 transition group-hover:text-blue-600">
                          {item.cta}
                          <span className="ml-2 transition group-hover:translate-x-0.5">→</span>
                        </span>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </section>
          </section>
        )}

        {activeSection === 'dashboard' && (
        <section className="dashboard-workspace">
          <section className="summary-strip">
            <Metric label="Active employees" value={`${activeCount}`} />
            <Metric label="Selected period hours" value={`${totalAssignedHours.toFixed(1)} hrs`} />
            <Metric label="Scheduled days" value={`${reviewedRange.weeks.length * 7}`} />
            <Metric label="Alerts" value={`${totalAlerts}`} accent={totalAlerts > 0 ? 'warn' : 'good'} />
          </section>
          <section className="panel-grid dashboard-grid">
          <article className="panel schedule-summary">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Period</p>
                <h2>{activePeriodLabel}</h2>
              </div>
              <button className="ghost-button" type="button" onClick={() => goToSection('schedules')}>
                Review schedule
              </button>
            </div>
            <p className="lede">
              The current period is the one you will see in Availability and Schedule. Use the buttons below to jump straight to the next task.
            </p>
            <div className="mini-nav">
              <button className="primary-button" type="button" onClick={() => goToSection('employees')}>
                Employees
              </button>
              <button className="ghost-button" type="button" onClick={() => goToSection('availability')}>
                Availability
              </button>
              <button className="ghost-button" type="button" onClick={() => goToSection('schedules')}>
                Schedule
              </button>
            </div>
          </article>
          <article className="panel alerts-panel">
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
                <strong>{totalAssignedHours.toFixed(1)} hrs</strong> projected period coverage
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
                type="button"
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
                    <small>{employee.priorityLevel} priority • {employee.active ? 'Active' : 'Inactive'}</small>
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
              <button className="primary-button" type="button" onClick={() => saveEmployee(employeeDraft)}>
                Save employee
              </button>
              {selectedEmployee && (
                <button className="ghost-button" type="button" onClick={() => deleteEmployee(selectedEmployee.id)}>
                  Delete selected
                </button>
              )}
            </div>
          </article>
        </section>
        )}

        {activeSection === 'availability' && selectedEmployee && (
        <section className="panel-grid availability-grid">
          <article className="panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Employees</p>
                <h2>Pick someone to edit</h2>
              </div>
            </div>
            <p className="muted">Select an employee, then set the weekly hours they can work.</p>
            <div className="employee-selector-list">
              {state.employees.map((employee) => (
                <button
                  key={employee.id}
                  className={employee.id === selectedEmployee.id ? 'employee-row active' : 'employee-row'}
                  type="button"
                  onClick={() => setSelectedEmployeeId(employee.id)}
                >
                  <span>
                    <strong>{employee.name}</strong>
                    <small>{employee.priorityLevel} priority</small>
                  </span>
                </button>
              ))}
            </div>
          </article>

          <article className="panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Weekly availability</p>
                <h2>{selectedEmployee.name}</h2>
              </div>
            </div>
            <p className="muted">This is recurring availability that repeats every week.</p>

            <div className="subpanel">
              <div className="panel-header compact">
                <div>
                  <h3>Quick add hours</h3>
                  <p className="muted">Choose a common block or enter a custom time.</p>
                </div>
              </div>
              <div className="preset-row">
                {QUICK_TIME_PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    className="ghost-button small"
                    onClick={() => setRangeDraft((current) => ({ ...current, start: preset.start, end: preset.end }))}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
              <div className="form-inline">
                <select name="availability-day" value={rangeDraft.day} onChange={(event) => setRangeDraft((current) => ({ ...current, day: event.target.value as DayKey }))}>
                  {DAYS.map((day) => (
                    <option key={day} value={day}>
                      {dayFullLabel(day)}
                    </option>
                  ))}
                </select>
                <input name="availability-start" type="time" value={rangeDraft.start} onChange={(event) => setRangeDraft((current) => ({ ...current, start: event.target.value }))} />
                <input name="availability-end" type="time" value={rangeDraft.end} onChange={(event) => setRangeDraft((current) => ({ ...current, end: event.target.value }))} />
                <button className="primary-button" type="button" onClick={addWeeklyAvailability}>
                  Add hours
                </button>
              </div>
            </div>

            <div className="subpanel">
              <div className="panel-header compact">
                <div>
                  <h3>Current weekly hours</h3>
                  <p className="muted">These hours repeat every week until you change them.</p>
                </div>
              </div>
              <RuleList
                items={selectedEmployeeAvailability.weeklyAvailability.map((item, index) => ({
                  id: `${item.day}-${index}`,
                  label: `${dayFullLabel(item.day)} ${item.ranges.map((range) => formatRange(range.start, range.end)).join(', ')}`,
                }))}
                onDelete={(id) => removeAvailabilityRule('weeklyAvailability', id)}
              />
            </div>
          </article>
        </section>
        )}

        {activeSection === 'setup' && (
        <section className="panel-grid two-up setup-grid">
          <article className="panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Business hours</p>
                <h2>Quick owner setup</h2>
              </div>
            </div>
            <div className="preset-row">
              {QUICK_TIME_PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    className="ghost-button small"
                    type="button"
                    onClick={() => setBusinessHoursDraft((current) => ({ ...current, start: preset.start, end: preset.end }))}
                  >
                  {preset.label}
                </button>
              ))}
            </div>
              <div className="form-inline">
              <select name="business-hours-day" value={businessHoursDraft.day} onChange={(event) => setBusinessHoursDraft((current) => ({ ...current, day: event.target.value as DayKey }))}>
                {DAYS.map((day) => (
                  <option key={day} value={day}>
                    {dayFullLabel(day)}
                  </option>
                ))}
              </select>
              <input name="business-hours-start" type="time" value={businessHoursDraft.start} onChange={(event) => setBusinessHoursDraft((current) => ({ ...current, start: event.target.value }))} />
              <input name="business-hours-end" type="time" value={businessHoursDraft.end} onChange={(event) => setBusinessHoursDraft((current) => ({ ...current, end: event.target.value }))} />
              <button className="primary-button" type="button" onClick={addBusinessHours}>
                Save hours
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
                        <button key={`${day}-${index}`} className="ghost-button small" type="button" onClick={() => deleteBusinessHours(day, index)}>
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
                <p className="eyebrow">Shift templates</p>
                <h2>Reusable quick adds</h2>
              </div>
            </div>
            <div className="preset-row">
              {DEFAULT_SHIFT_TEMPLATES.map((preset) => (
                  <button
                    key={preset.label}
                    className="ghost-button small"
                    type="button"
                    onClick={() =>
                      setTemplateDraft((current) => ({
                      ...current,
                      label: preset.label,
                      start: preset.start,
                      end: preset.end,
                      requiredStaff: preset.requiredStaff,
                    }))
                  }
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <div className="form-grid narrow">
              <Field label="Label">
                <input value={templateDraft.label} onChange={(event) => setTemplateDraft((current) => ({ ...current, label: event.target.value }))} />
              </Field>
              <Field label="Start">
                <input type="time" value={templateDraft.start} onChange={(event) => setTemplateDraft((current) => ({ ...current, start: event.target.value }))} />
              </Field>
              <Field label="End">
                <input type="time" value={templateDraft.end} onChange={(event) => setTemplateDraft((current) => ({ ...current, end: event.target.value }))} />
              </Field>
              <Field label="Staff needed">
                <input type="number" min="1" step="1" value={templateDraft.requiredStaff} onChange={(event) => setTemplateDraft((current) => ({ ...current, requiredStaff: Number(event.target.value) }))} />
              </Field>
              <Field label="Notes">
                <input value={templateDraft.notes} onChange={(event) => setTemplateDraft((current) => ({ ...current, notes: event.target.value }))} />
              </Field>
            </div>
            <div className="inline-actions">
              <button className="primary-button" type="button" onClick={saveShiftTemplate}>
                {editingTemplateId ? 'Update template' : 'Save template'}
              </button>
              {editingTemplateId && (
                <button
                  className="ghost-button"
                  type="button"
                  onClick={() => {
                    setEditingTemplateId(null);
                    setTemplateDraft({
                      label: 'Open',
                      start: '08:00',
                      end: '12:00',
                      requiredStaff: 2,
                      notes: '',
                    });
                  }}
                >
                  Cancel edit
                </button>
              )}
            </div>
            <div className="spacer" />
            <div className="scroll-list">
              {state.shiftTemplates.map((template) => (
                <div key={template.id} className="requirement-row">
                  <div>
                    <strong>{template.label}</strong>
                    <p className="muted">
                      {template.start} - {template.end} • {template.requiredStaff} staff
                    </p>
                    <p className="muted">{template.notes || 'Quick add template'}</p>
                  </div>
                  <div className="row-actions">
                    <button className="ghost-button small" type="button" onClick={() => editShiftTemplate(template.id)}>
                      Edit
                    </button>
                    <button className="ghost-button small" type="button" onClick={() => deleteShiftTemplate(template.id)}>
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </article>
        </section>
        )}

        {activeSection === 'schedules' && scheduleWeek && (
          <section className="space-y-6">
            <header className="sticky top-4 z-30 rounded-[28px] border border-slate-200/80 bg-white/95 p-4 shadow-sm backdrop-blur xl:top-6">
              <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
                <div className="space-y-3">
                  <div className="inline-flex items-center rounded-full border border-blue-100 bg-blue-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.24em] text-blue-700">
                    Weekly schedule
                  </div>
                  <div>
                    <h2 className="text-3xl font-semibold tracking-tight text-slate-950 md:text-4xl">{formatWeekLabel(scheduleWeek.weekStart, scheduleWeek.weekEnd)}</h2>
                    <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600 md:text-base">
                      {selectedPeriod.label} • {activeEmployees.length} active people • {scheduleWeek.schedule.totalHours.toFixed(1)} scheduled hours •{' '}
                      {underfilledCount} open shift{underfilledCount === 1 ? '' : 's'}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button className={INLINE_BUTTON} type="button" onClick={() => shiftScheduleWeek(-1)}>
                      Previous week
                    </button>
                    <button className={INLINE_BUTTON} type="button" onClick={() => shiftScheduleWeek(1)}>
                      Next week
                    </button>
                    <button className={INLINE_BUTTON} type="button" onClick={copyLastWeek}>
                      Copy last week
                    </button>
                    <button className={INLINE_BUTTON_PRIMARY} type="button" onClick={buildScheduleNow}>
                      Build schedule
                    </button>
                    <button className={INLINE_BUTTON_MUTED} type="button" onClick={autoOptimizeSchedule}>
                      Fix conflicts
                    </button>
                    <button className={INLINE_BUTTON} type="button" onClick={saveScheduleDraft}>
                      Save draft
                    </button>
                    <button
                      className={INLINE_BUTTON_SUCCESS}
                      type="button"
                      onClick={publishSchedule}
                      disabled={reviewedRange.alerts.some((alert) => alert.kind !== 'hours')}
                    >
                      Publish to Team
                    </button>
                    <button className={INLINE_BUTTON} type="button" onClick={() => window.print()}>
                      Export calendar PDF
                    </button>
                  </div>
                </div>

                  <div className="grid gap-3 sm:grid-cols-2 xl:min-w-[360px] xl:grid-cols-2">
                  <div className={INLINE_CARD}>
                    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Hours</p>
                    <p className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">{scheduleWeek.schedule.totalHours.toFixed(1)}</p>
                    <p className="text-sm text-slate-500">Scheduled this week</p>
                  </div>
                  <div className={INLINE_CARD}>
                    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Open shifts</p>
                    <p className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">{underfilledCount}</p>
                    <p className="text-sm text-slate-500">Need attention</p>
                  </div>
                  <div className={INLINE_CARD}>
                    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Conflicts</p>
                    <p className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">{reviewedRange.alerts.filter((alert) => alert.kind === 'validation').length}</p>
                    <p className="text-sm text-slate-500">Blocking issues</p>
                  </div>
                  <div className={INLINE_CARD}>
                    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Save state</p>
                    <p className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">{state.schedulePublishedAt ? 'Published' : 'Draft'}</p>
                    <p className="text-sm text-slate-500">{lastGeneratedAt ? `Optimized ${new Date(lastGeneratedAt).toLocaleTimeString()}` : 'Ready to work'}</p>
                  </div>
                </div>
              </div>
            </header>

            <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
              <div className="space-y-6">
                <article id="schedule-quick-add" className={SURFACE_CARD_PAD}>
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">Quick add</p>
                      <h3 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">Create a staffing block</h3>
                      <p className="mt-2 text-sm leading-6 text-slate-500">Choose a day and add one of the reusable shift templates.</p>
                    </div>
                    <button className={INLINE_BUTTON} type="button" onClick={() => goToSection('setup')}>
                      Edit templates
                    </button>
                  </div>
                  <div className="mt-5 flex flex-wrap gap-2">
                    {DAYS.map((day) => (
                      <button
                        key={day}
                        className={`rounded-full px-4 py-2 text-sm font-semibold transition ${
                          requirementDraft.day === day
                            ? 'bg-blue-600 text-white shadow-sm'
                            : 'border border-slate-200 bg-white text-slate-700 hover:border-blue-200 hover:bg-blue-50'
                        }`}
                        onClick={() => jumpToScheduleDay(day)}
                      >
                        {dayFullLabel(day)}
                      </button>
                    ))}
                  </div>
                  <div className="mt-5 flex flex-wrap gap-2">
                    {activeShiftTemplates.map((template) => (
                      <button
                        key={template.id}
                        className={INLINE_BUTTON_MUTED}
                        type="button"
                        onClick={() => addRequirementFromTemplate(template)}
                      >
                        {template.label} <span className="text-slate-400">{template.start} - {template.end}</span>
                      </button>
                    ))}
                  </div>
                </article>

                <article className="overflow-hidden rounded-[28px] border border-slate-200/80 bg-white/90 shadow-sm">
                  <div className="flex flex-col gap-3 border-b border-slate-200 px-5 py-5 lg:flex-row lg:items-end lg:justify-between">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">Schedule board</p>
                      <h3 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">Employees across Mon-Sun</h3>
                      <p className="mt-2 text-sm leading-6 text-slate-500">Tap a shift to edit it, or drop it on another person to reassign it.</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <span className="inline-flex items-center rounded-full bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-700 ring-1 ring-blue-200">Blue = active</span>
                      <span className="inline-flex items-center rounded-full bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-700 ring-1 ring-amber-200">Amber = risk</span>
                      <span className="inline-flex items-center rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-200">Green = good</span>
                    </div>
                  </div>

                  <div className="overflow-x-auto">
                    <div className="min-w-[1280px]">
                      <div
                        className="grid border-b border-slate-200 bg-slate-50/80"
                        style={{ gridTemplateColumns: 'minmax(240px, 320px) repeat(7, minmax(170px, 1fr))' }}
                      >
                        <div className="sticky left-0 z-20 border-r border-slate-200 bg-slate-50/95 px-4 py-4">
                          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">Employee</p>
                          <p className="mt-1 text-sm font-semibold text-slate-900">Weekly load</p>
                        </div>
                        {DAYS.map((day) => {
                          const summary = scheduleDaySummaries[day];
                          const date = addDays(scheduleWeek.weekStart, DAYS.indexOf(day));
                          return (
                            <div key={day} className="border-r border-slate-200 px-4 py-4 last:border-r-0">
                              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">{dayFullLabel(day)}</p>
                              <p className="mt-1 text-sm font-semibold text-slate-950">{formatDayDate(date)}</p>
                              <div className="mt-3 flex flex-wrap gap-2">
                                <span className="inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700">
                                  {summary.totalRequired} needed
                                </span>
                                <span className="inline-flex rounded-full bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-700">
                                  {summary.totalAssigned} assigned
                                </span>
                              </div>
                            </div>
                          );
                        })}
                      </div>

                      <div className="divide-y divide-slate-200">
                        {activeEmployees.map((employee) => {
                          const employeeHours = reviewedRange.employeeHours[employee.id] ?? 0;
                          const availability = state.availability[employee.id] ?? createEmptyAvailability();
                          return (
                            <div
                              key={employee.id}
                              className="grid min-h-[112px]"
                              style={{ gridTemplateColumns: 'minmax(240px, 320px) repeat(7, minmax(170px, 1fr))' }}
                            >
                              <button
                                className={`sticky left-0 z-10 border-r border-slate-200 px-4 py-4 text-left transition ${
                                  selectedScheduleEmployee?.id === employee.id ? 'bg-blue-50/95' : 'bg-white/95 hover:bg-slate-50'
                                }`}
                                onClick={() => selectScheduleEmployee(employee.id)}
                              >
                                <div className="flex items-start justify-between gap-3">
                                  <div>
                                    <p className="text-base font-semibold text-slate-950">{employee.name}</p>
                                    <p className="mt-1 text-sm text-slate-500">
                                      {employeeHours.toFixed(1)} / {employee.maxAllowedWeeklyHours} hrs
                                    </p>
                                  </div>
                                  <span
                                    className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                                      employeeHours > employee.maxAllowedWeeklyHours
                                        ? 'bg-rose-50 text-rose-700 ring-1 ring-rose-200'
                                        : employeeHours > employee.maxAllowedWeeklyHours * 0.85
                                        ? 'bg-amber-50 text-amber-700 ring-1 ring-amber-200'
                                        : 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200'
                                    }`}
                                  >
                                    {employeeHours > employee.maxAllowedWeeklyHours ? 'Over' : employeeHours > employee.maxAllowedWeeklyHours * 0.85 ? 'Near max' : 'Good'}
                                  </span>
                                </div>
                                <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100">
                                  <div
                                    className={`h-full rounded-full ${
                                      employeeHours > employee.maxAllowedWeeklyHours
                                        ? 'bg-rose-500'
                                        : employeeHours > employee.maxAllowedWeeklyHours * 0.85
                                        ? 'bg-amber-500'
                                        : 'bg-blue-500'
                                    }`}
                                    style={{
                                      width: `${Math.min(100, employee.maxAllowedWeeklyHours ? (employeeHours / employee.maxAllowedWeeklyHours) * 100 : 0)}%`,
                                    }}
                                  />
                                </div>
                              </button>

                              {DAYS.map((day) => {
                                const date = isoDateForWeekDay(scheduleWeek.weekStart, day);
                                const assignments = scheduleAssignments.filter((assignment) => assignment.employeeId === employee.id && assignment.day === day);
                                const requirements = scheduleDaySummaries[day].blocks;
                                const employeeAvailabilityBlocks = availability.weeklyAvailability.filter((rule) => rule.day === day);
                                const canWorkAny = employeeAvailabilityBlocks.length > 0;
                                const rowConflicts = assignments
                                  .map((assignment) =>
                                    canWorkBlock(
                                      assignment.employeeId,
                                      { day: assignment.day, start: assignment.start, end: assignment.end, date: assignment.date },
                                      state,
                                      scheduleAssignments
                                        .filter((other) => other.id !== assignment.id)
                                        .map((other) => ({ employeeId: other.employeeId, day: other.day, start: other.start, end: other.end })),
                                    ),
                                  )
                                  .filter((result) => !result.allowed);

                                return (
                                  <div
                                    key={`${employee.id}-${day}`}
                                    className={`min-h-[112px] border-r border-slate-200 px-3 py-3 last:border-r-0 ${
                                      !canWorkAny ? 'bg-rose-50/60' : 'bg-white'
                                    }`}
                                    onDragOver={(event) => event.preventDefault()}
                                    onDrop={() => moveDraggedAssignmentToEmployee(employee.id)}
                                  >
                                    <button
                                      className="flex min-h-24 w-full flex-col items-center justify-center rounded-[20px] border border-dashed border-slate-200 bg-slate-50 px-3 py-3 text-center text-sm font-semibold text-slate-500 transition hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700 focus-visible:ring-2 focus-visible:ring-blue-200 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
                                      type="button"
                                      onClick={() => jumpToScheduleDay(day)}
                                    >
                                      <span>Add shift</span>
                                      <span className="mt-1 text-xs font-medium text-slate-400">{formatDayDate(new Date(date))}</span>
                                    </button>

                                    <div className="mt-3 space-y-2">
                                      {assignments.map((assignment) => {
                                        const requirement = requirements.find((entry) => entry.id === assignment.blockId);
                                        const conflict = canWorkBlock(
                                          assignment.employeeId,
                                          { day: assignment.day, start: assignment.start, end: assignment.end, date: assignment.date },
                                          state,
                                          scheduleAssignments
                                            .filter((other) => other.id !== assignment.id)
                                            .map((other) => ({ employeeId: other.employeeId, day: other.day, start: other.start, end: other.end })),
                                        );
                                        const assignmentTone = !conflict.allowed
                                          ? 'border-rose-200 bg-rose-50 text-rose-800'
                                          : employeeHours > employee.maxAllowedWeeklyHours * 0.85
                                          ? 'border-amber-200 bg-amber-50 text-amber-800'
                                          : 'border-blue-200 bg-blue-50 text-blue-800';
                                        return (
                                          <button
                                            key={assignment.id}
                                            draggable
                                            onDragStart={() => setDraggedScheduleAssignment(assignment.id)}
                                            onClick={() => selectScheduleAssignment(assignment.id, employee.id)}
                                            className={`group flex w-full flex-col gap-1 rounded-[18px] border px-3 py-3 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-lg ${assignmentTone}`}
                                          >
                                            <div className="flex items-center justify-between gap-2">
                                              <span className="text-sm font-semibold">{formatRange(assignment.start, assignment.end)}</span>
                                              <span className="rounded-full bg-white/60 px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]">
                                                {assignment.slotIndex + 1}/{assignment.requiredStaff}
                                              </span>
                                            </div>
                                            <p className="text-xs font-medium opacity-80">{requirement?.notes || 'Coverage shift'}</p>
                                            <div className="flex flex-wrap gap-2">
                                              <span className="rounded-full bg-white/70 px-2 py-1 text-[11px] font-semibold">Drag me</span>
                                              {!conflict.allowed && <span className="rounded-full bg-rose-100 px-2 py-1 text-[11px] font-semibold text-rose-700">Conflict</span>}
                                            </div>
                                          </button>
                                        );
                                      })}
                                    </div>

                                    {rowConflicts.length > 0 && (
                                      <div className="mt-3 rounded-[16px] border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700">
                                        Availability conflict
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </article>

                <article className="hidden printable-area">
                  <PrintableScheduleCalendar
                    range={reviewedRange}
                    periodStart={selectedPeriod.start}
                    periodEnd={selectedPeriod.end}
                    selectedPeriodLabel={selectedPeriod.label}
                    totalAlerts={totalAlerts}
                  />
                </article>
              </div>

              <aside className="space-y-6 xl:sticky xl:top-6">
                <article className={SURFACE_CARD}>
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">Shift details</p>
                      <h3 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">Details</h3>
                    </div>
                    <button className="text-sm font-semibold text-blue-700 transition hover:text-blue-600 focus-visible:ring-2 focus-visible:ring-blue-200 focus-visible:ring-offset-2 focus-visible:ring-offset-white" type="button" onClick={() => setSelectedScheduleAssignmentId('')}>
                      Clear
                    </button>
                  </div>

                  {selectedScheduleAssignment ? (
                    <div className="mt-5 space-y-4">
                      <div className="rounded-[20px] bg-slate-50 p-4 ring-1 ring-slate-200">
                        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">Shift</p>
                        <p className="mt-2 text-xl font-semibold tracking-tight text-slate-950">{formatRange(selectedScheduleAssignment.start, selectedScheduleAssignment.end)}</p>
                        <p className="mt-1 text-sm text-slate-500">
                          {dayFullLabel(selectedScheduleAssignment.day)} • {selectedScheduleAssignment.employeeName}
                        </p>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div className={INLINE_CARD}>
                          <p className="text-sm font-medium text-slate-500">Required staff</p>
                          <p className="mt-1 text-lg font-semibold text-slate-950">{selectedScheduleAssignment.requiredStaff}</p>
                        </div>
                        <div className={INLINE_CARD}>
                          <p className="text-sm font-medium text-slate-500">Slot</p>
                          <p className="mt-1 text-lg font-semibold text-slate-950">
                            {selectedScheduleAssignment.slotIndex + 1} / {selectedScheduleAssignment.requiredStaff}
                          </p>
                        </div>
                      </div>
                      <div className={INLINE_CARD}>
                        <p className="text-sm font-medium text-slate-500">Notes</p>
                        <p className="mt-1 text-sm leading-6 text-slate-700">
                          {scheduleDaySummaries[selectedScheduleAssignment.day].blocks.find((entry) => entry.id === selectedScheduleAssignment.blockId)?.notes || 'General coverage'}
                        </p>
                      </div>

                      <div className="rounded-[20px] border border-slate-200 bg-white p-4">
                        <p className="text-sm font-semibold text-slate-900">Edit assignment</p>
                        <select
                          name="assignment-override"
                          className="mt-3 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700 focus-visible:ring-2 focus-visible:ring-blue-200 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
                          value={Object.prototype.hasOwnProperty.call(state.scheduleOverrides, scheduleAssignmentKey({
                            date: selectedScheduleAssignment.date,
                            blockId: selectedScheduleAssignment.blockId,
                            slotIndex: selectedScheduleAssignment.slotIndex,
                          }))
                            ? state.scheduleOverrides[
                                scheduleAssignmentKey({
                                  date: selectedScheduleAssignment.date,
                                  blockId: selectedScheduleAssignment.blockId,
                                  slotIndex: selectedScheduleAssignment.slotIndex,
                                })
                              ] ?? '__clear__'
                            : selectedScheduleAssignment.employeeId}
                          onChange={(event) =>
                            setScheduleOverride(
                              scheduleAssignmentKey({
                                date: selectedScheduleAssignment.date,
                                blockId: selectedScheduleAssignment.blockId,
                                slotIndex: selectedScheduleAssignment.slotIndex,
                              }),
                              event.target.value,
                            )
                          }
                        >
                          <option value="__inherit__">Keep generated</option>
                          <option value="__clear__">Unassigned</option>
                          {activeEmployees.map((employee) => (
                            <option key={employee.id} value={employee.id}>
                              {employee.name}
                            </option>
                          ))}
                        </select>
                        <div className="mt-4 flex flex-wrap gap-2">
                          <button className={INLINE_BUTTON} type="button" onClick={() => selectScheduleEmployee(selectedScheduleAssignment.employeeId)}>
                            Open employee
                          </button>
                          <button className={INLINE_BUTTON} type="button" onClick={() => goToSection('availability')}>
                            Availability
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : selectedScheduleEmployee ? (
                    <div className="mt-5 space-y-4">
                      <div className={INLINE_CARD}>
                        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">Employee</p>
                        <p className="mt-2 text-xl font-semibold tracking-tight text-slate-950">{selectedScheduleEmployee.name}</p>
                        <p className="mt-1 text-sm text-slate-500">
                          {reviewedRange.employeeHours[selectedScheduleEmployee.id]?.toFixed(1) ?? '0.0'} hrs scheduled
                        </p>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div className={INLINE_CARD}>
                          <p className="text-sm font-medium text-slate-500">Preferred</p>
                          <p className="mt-1 text-lg font-semibold text-slate-950">{selectedScheduleEmployee.minPreferredWeeklyHours} hrs</p>
                        </div>
                        <div className={INLINE_CARD}>
                          <p className="text-sm font-medium text-slate-500">Maximum</p>
                          <p className="mt-1 text-lg font-semibold text-slate-950">{selectedScheduleEmployee.maxAllowedWeeklyHours} hrs</p>
                        </div>
                      </div>
                      <div className={INLINE_CARD}>
                          <p className="text-sm font-medium text-slate-500">Availability</p>
                        <p className="mt-1 text-sm leading-6 text-slate-700">
                          {selectedScheduleEmployee.id in state.availability && state.availability[selectedScheduleEmployee.id].weeklyAvailability.length
                            ? `${state.availability[selectedScheduleEmployee.id].weeklyAvailability.length} weekly availability block(s)`
                            : 'No weekly availability entered yet.'}
                        </p>
                      </div>
                      <div className={INLINE_CARD}>
                        <p className="text-sm font-medium text-slate-500">Notes</p>
                        <p className="mt-1 text-sm leading-6 text-slate-700">{selectedScheduleEmployee.notes || 'No notes added.'}</p>
                      </div>
                      <button
                        className={INLINE_BUTTON_PRIMARY}
                        type="button"
                        onClick={() => goToSection('availability')}
                      >
                        Open availability
                      </button>
                    </div>
                  ) : (
                    <div className={INLINE_CARD}>
                      Select a shift or employee on the board to see details here.
                    </div>
                  )}
                </article>

                <article className="rounded-[28px] border border-slate-200/80 bg-white/95 p-6 shadow-sm">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">Status</p>
                      <h3 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">Week health</h3>
                    </div>
                    <span
                      className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${
                        feasibility.feasible ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200' : 'bg-amber-50 text-amber-700 ring-1 ring-amber-200'
                      }`}
                    >
                      {feasibility.feasible ? 'Ready' : 'Needs attention'}
                    </span>
                  </div>
                  <div className="mt-5 space-y-3">
                    <div className="rounded-[20px] bg-slate-50 p-4 ring-1 ring-slate-200">
                      <p className="text-sm font-medium text-slate-500">Hours needed vs hours available</p>
                      <p className="mt-1 text-sm font-semibold text-slate-950">
                        {feasibility.totalRequiredHours.toFixed(1)} hrs needed · {feasibility.estimatedCapacityHours.toFixed(1)} hrs available
                      </p>
                    </div>
                    <div className="rounded-[20px] bg-slate-50 p-4 ring-1 ring-slate-200">
                      <p className="text-sm font-medium text-slate-500">Availability ready</p>
                      <p className="mt-1 text-sm font-semibold text-slate-950">{activeAvailabilityCount} people have weekly availability</p>
                    </div>
                    <div className="rounded-[20px] bg-slate-50 p-4 ring-1 ring-slate-200">
                      <p className="text-sm font-medium text-slate-500">Last update</p>
                      <p className="mt-1 text-sm font-semibold text-slate-950">{lastGeneratedAt ? new Date(lastGeneratedAt).toLocaleString() : 'Not optimized yet'}</p>
                    </div>
                  </div>
                </article>
              </aside>
            </div>

            <article className="hidden printable-area">
              <PrintableScheduleCalendar
                range={reviewedRange}
                periodStart={selectedPeriod.start}
                periodEnd={selectedPeriod.end}
                selectedPeriodLabel={selectedPeriod.label}
                totalAlerts={totalAlerts}
              />
            </article>

            <div className="sticky bottom-4 z-30 mx-auto grid max-w-5xl gap-2 rounded-[24px] border border-slate-200/80 bg-white/95 p-3 shadow-xl backdrop-blur lg:hidden">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <button className={INLINE_BUTTON_PRIMARY} type="button" onClick={buildScheduleNow}>
                  Build
                </button>
                <button className={INLINE_BUTTON} type="button" onClick={saveScheduleDraft}>
                  Save
                </button>
                <button className={INLINE_BUTTON_SUCCESS} type="button" onClick={publishSchedule} disabled={reviewedRange.alerts.some((alert) => alert.kind !== 'hours')}>
                  Publish to Team
                </button>
                <button className={INLINE_BUTTON} type="button" onClick={() => window.print()}>
                  Export
                </button>
              </div>
            </div>
          </section>
        )}

        {activeSection === 'guide' && (
        <UserGuide
          onOpenEmployees={() => goToSection('employees')}
          onOpenAvailability={() => goToSection('availability')}
          onOpenSetup={() => goToSection('setup')}
          onOpenSchedules={() => goToSection('schedules')}
          onOpenDashboard={() => goToSection('dashboard')}
          onOpenDrive={() => setShowDriveMenu(true)}
        />
        )}
      </div>
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

function SectionGlyph({ kind }: { kind: 'schedule' | 'availability' | 'setup' | 'employees' | 'dashboard' | 'guide' }) {
  const common = {
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };

  switch (kind) {
    case 'schedule':
      return (
        <svg viewBox="0 0 24 24" className="h-6 w-6" aria-hidden="true">
          <rect x="3.5" y="5.5" width="17" height="15" rx="3" {...common} />
          <path d="M8 3.5v4M16 3.5v4M3.5 9.5h17" {...common} />
        </svg>
      );
    case 'availability':
      return (
        <svg viewBox="0 0 24 24" className="h-6 w-6" aria-hidden="true">
          <circle cx="12" cy="12" r="7.5" {...common} />
          <path d="M12 8.5v4l2.5 1.5" {...common} />
        </svg>
      );
    case 'setup':
      return (
        <svg viewBox="0 0 24 24" className="h-6 w-6" aria-hidden="true">
          <path d="M4 7h16M4 12h16M4 17h16" {...common} />
          <circle cx="9" cy="7" r="1.8" fill="currentColor" stroke="none" />
          <circle cx="15" cy="12" r="1.8" fill="currentColor" stroke="none" />
          <circle cx="11" cy="17" r="1.8" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'employees':
      return (
        <svg viewBox="0 0 24 24" className="h-6 w-6" aria-hidden="true">
          <circle cx="9" cy="8.5" r="3" {...common} />
          <path d="M3.8 18.5c.8-3 3-5 5.2-5s4.4 2 5.2 5" {...common} />
          <path d="M15.5 8.5h4M17.5 6.5v4" {...common} />
        </svg>
      );
    case 'dashboard':
      return (
        <svg viewBox="0 0 24 24" className="h-6 w-6" aria-hidden="true">
          <path d="M4 19h16" {...common} />
          <rect x="5" y="11" width="3.5" height="5.5" rx="1" {...common} />
          <rect x="10.25" y="8" width="3.5" height="8.5" rx="1" {...common} />
          <rect x="15.5" y="5.5" width="3.5" height="11" rx="1" {...common} />
        </svg>
      );
    case 'guide':
      return (
        <svg viewBox="0 0 24 24" className="h-6 w-6" aria-hidden="true">
          <path d="M6 4.5h9.5a2 2 0 0 1 2 2V20H8a2 2 0 0 1-2-2V4.5Z" {...common} />
          <path d="M6 4.5A2 2 0 0 0 4 6.5V18a2 2 0 0 0 2 2" {...common} />
          <path d="M9 8h6M9 11h6M9 14h4" {...common} />
        </svg>
      );
  }
}

function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const normalizedName = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const input = isValidElement(children)
    ? (() => {
        const child = children as ReactElement<{ name?: string; autoComplete?: string }>;
        return cloneElement(child, {
          name: child.props.name ?? normalizedName,
          autoComplete: child.props.autoComplete ?? 'off',
        });
      })()
    : children;

  return (
    <label className="field">
      <span>{label}</span>
      {input}
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
          <button className="ghost-button small" type="button" onClick={() => onDelete(item.id)}>
            Remove
          </button>
        </div>
      ))}
    </div>
  );
}

function PrintableScheduleCalendar({
  range,
  periodStart,
  periodEnd,
  selectedPeriodLabel,
  totalAlerts,
}: {
  range: GeneratedScheduleRange;
  periodStart: Date;
  periodEnd: Date;
  selectedPeriodLabel: string;
  totalAlerts: number;
}) {
  const calendarStart = new Date(periodStart);
  calendarStart.setHours(12, 0, 0, 0);
  const calendarEnd = new Date(periodEnd);
  calendarEnd.setHours(12, 0, 0, 0);
  const leadingBlankDays = calendarStart.getDay();
  const calendarDays: Date[] = [];
  for (let cursor = new Date(calendarStart); cursor <= calendarEnd; cursor = addDays(cursor, 1)) {
    calendarDays.push(new Date(cursor));
  }
  const trailingBlankDays = (7 - ((leadingBlankDays + calendarDays.length) % 7)) % 7;
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
          <strong>{formatMonthYear(calendarStart)}</strong>
        </div>
        <strong>{selectedPeriodLabel}</strong>
        <span>{totalAlerts} issue(s)</span>
      </div>
      <div className="month-calendar">
        {['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((day) => (
          <div key={day} className="month-day-name">
            {day}
          </div>
        ))}
        {Array.from({ length: leadingBlankDays }, (_, index) => (
          <div key={`start-pad-${index}`} className="month-cell month-placeholder" aria-hidden="true" />
        ))}
        {calendarDays.map((date) => {
          const isoDate = date.toISOString().slice(0, 10);
          const assignments = (assignmentsByDate.get(isoDate) ?? []).sort((a, b) => (parseTime(a.start) ?? 0) - (parseTime(b.start) ?? 0));

          return (
            <div key={isoDate} className="month-cell">
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
        {Array.from({ length: trailingBlankDays }, (_, index) => (
          <div key={`end-pad-${index}`} className="month-cell month-placeholder" aria-hidden="true" />
        ))}
      </div>
    </div>
  );
}

function UserGuide({
  onOpenEmployees,
  onOpenAvailability,
  onOpenSetup,
  onOpenSchedules,
  onOpenDashboard,
  onOpenDrive,
}: {
  onOpenEmployees: () => void;
  onOpenAvailability: () => void;
  onOpenSetup: () => void;
  onOpenSchedules: () => void;
  onOpenDashboard: () => void;
  onOpenDrive: () => void;
}) {
  return (
    <section className="guide-workspace">
      <div className="workspace-heading">
        <div>
          <p className="eyebrow">Guide</p>
          <h2>How to build and publish a weekly schedule</h2>
        </div>
      </div>

      <div className="guide-grid">
        <article className="guide-section">
          <span className="guide-number">1</span>
          <div>
            <h3>Add people</h3>
              <p>
              Open People and enter each person&apos;s name, preferred hours, maximum hours, and priority level.
              Higher priority people are considered first when the schedule is generated.
            </p>
            <button className="ghost-button" type="button" onClick={onOpenEmployees}>Open People</button>
          </div>
        </article>

        <article className="guide-section">
          <span className="guide-number">2</span>
          <div>
            <h3>Set availability</h3>
            <p>
              Open Availability, choose the person, then add the days and times that person can work each week. Keep this screen simple:
              select the day, enter the times, and save the weekly hours.
            </p>
            <button className="ghost-button" type="button" onClick={onOpenAvailability}>View Availability</button>
          </div>
        </article>

        <article className="guide-section">
          <span className="guide-number">3</span>
          <div>
            <h3>Set hours and shift patterns</h3>
            <p>
              Open Shifts to define the business hours and reusable shift patterns. This is where you make the common shifts that you
              can add quickly later.
            </p>
            <button className="ghost-button" type="button" onClick={onOpenSetup}>Open Shifts</button>
          </div>
        </article>

        <article className="guide-section">
          <span className="guide-number">4</span>
          <div>
            <h3>Build and review</h3>
            <p>
              Tap Build Schedule. Then use the quick-add shift buttons, review every slot in the schedule, and swap or clear any
              assignment before publishing.
            </p>
          </div>
        </article>

        <article className="guide-section">
          <span className="guide-number">5</span>
          <div>
            <h3>Fix conflicts before publishing</h3>
            <p>
              If the schedule has conflicts or understaffed blocks, the app will list them in Alerts. Fix the availability, staffing
              need, or manual assignment before publishing.
            </p>
            <button className="ghost-button" type="button" onClick={onOpenDashboard}>Open Week Summary</button>
          </div>
        </article>

        <article className="guide-section">
          <span className="guide-number">6</span>
          <div>
            <h3>Publish to team and export</h3>
            <p>
              When the schedule is ready, tap Publish to Team. Then tap Export Calendar PDF to print or save a posted team calendar.
            </p>
            <button className="primary-button" type="button" onClick={onOpenSchedules}>Open Schedule</button>
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
            <button className="ghost-button" type="button" onClick={onOpenDrive}>Open Google Drive Backup</button>
          </div>
        </article>
      </div>
    </section>
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
            className={`${CHOICE_PILL} ${period.mode === mode ? 'section-chip active' : 'section-chip'}`}
            type="button"
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
