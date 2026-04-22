import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkScheduleFeasibility,
  applyScheduleOverrides,
  generateSchedule,
  generateScheduleRange,
  canWorkBlock,
  weekStartMonday,
  type AppState,
  type DayKey,
  type Employee,
} from '../lib/staffing';

function employee(overrides: Partial<Employee> & Pick<Employee, 'id' | 'name'>): Employee {
  return {
    id: overrides.id,
    name: overrides.name,
    minPreferredWeeklyHours: overrides.minPreferredWeeklyHours ?? 0,
    maxAllowedWeeklyHours: overrides.maxAllowedWeeklyHours ?? 40,
    priorityLevel: overrides.priorityLevel ?? 3,
    active: overrides.active ?? true,
    notes: overrides.notes ?? '',
  };
}

function emptyAvailability() {
  return {
    weeklyAvailability: [],
    weeklyUnavailability: [],
    exceptions: [],
  };
}

function baseState(overrides: Partial<AppState> = {}): AppState {
  return {
    employees: overrides.employees ?? [],
    availability: overrides.availability ?? {},
    businessHours:
      overrides.businessHours ??
      ([
        { day: 'mon', ranges: [{ start: '08:00', end: '18:00' }] },
        { day: 'tue', ranges: [{ start: '08:00', end: '18:00' }] },
        { day: 'wed', ranges: [{ start: '08:00', end: '18:00' }] },
        { day: 'thu', ranges: [{ start: '08:00', end: '18:00' }] },
        { day: 'fri', ranges: [{ start: '08:00', end: '18:00' }] },
        { day: 'sat', ranges: [] },
        { day: 'sun', ranges: [] },
      ] as AppState['businessHours']),
    staffingRequirements: overrides.staffingRequirements ?? [],
    shiftTemplates: overrides.shiftTemplates ?? [],
    scheduleOverrides: overrides.scheduleOverrides ?? {},
    schedulePublishedAt: overrides.schedulePublishedAt ?? null,
    updatedAt: overrides.updatedAt ?? new Date().toISOString(),
  };
}

function monday(date = '2026-04-20') {
  return weekStartMonday(new Date(`${date}T12:00:00`));
}

test('canWorkBlock respects weekly unavailability and full date exceptions', () => {
  const emp = employee({ id: 'emp-1', name: 'Taylor', minPreferredWeeklyHours: 0, maxAllowedWeeklyHours: 40 });
  const exceptionEmp = employee({ id: 'emp-2', name: 'Drew', minPreferredWeeklyHours: 0, maxAllowedWeeklyHours: 40 });
  const state = baseState({
    employees: [emp, exceptionEmp],
    availability: {
      [emp.id]: {
        weeklyAvailability: [{ day: 'mon', ranges: [{ start: '08:00', end: '18:00' }] }],
        weeklyUnavailability: [{ day: 'mon', ranges: [{ start: '12:00', end: '13:00' }] }],
        exceptions: [],
      },
      [exceptionEmp.id]: {
        weeklyAvailability: [],
        weeklyUnavailability: [],
        exceptions: [{ id: 'exc-1', date: '2026-04-20', type: 'available', start: '09:00', end: '13:00', notes: 'Doctor moved' }],
      },
    },
    staffingRequirements: [
      { id: 'req-1', day: 'mon', start: '10:00', end: '12:00', requiredStaff: 1 },
    ],
  });

  assert.equal(
    canWorkBlock(
      emp.id,
      { day: 'mon', start: '10:00', end: '12:00', date: '2026-04-20' },
      state,
      [],
    ).allowed,
    true,
  );

  assert.equal(
    canWorkBlock(
      emp.id,
      { day: 'mon', start: '12:00', end: '12:30', date: '2026-04-20' },
      state,
      [],
    ).allowed,
    false,
  );

  assert.equal(
    canWorkBlock(
      exceptionEmp.id,
      { day: 'mon', start: '10:00', end: '12:00', date: '2026-04-20' },
      state,
      [],
    ).allowed,
    true,
  );

  assert.equal(
    canWorkBlock(
      exceptionEmp.id,
      { day: 'mon', start: '09:00', end: '14:00', date: '2026-04-20' },
      state,
      [],
    ).allowed,
    false,
  );
});

test('generateSchedule fills a requirement with available employees and keeps priority ordering', () => {
  const high = employee({ id: 'emp-1', name: 'Ava', priorityLevel: 5, minPreferredWeeklyHours: 4, maxAllowedWeeklyHours: 8 });
  const medium = employee({ id: 'emp-2', name: 'Ben', priorityLevel: 3, minPreferredWeeklyHours: 0, maxAllowedWeeklyHours: 8 });
  const low = employee({ id: 'emp-3', name: 'Chloe', priorityLevel: 1, minPreferredWeeklyHours: 0, maxAllowedWeeklyHours: 8 });

  const state = baseState({
    employees: [high, medium, low],
    availability: {
      [high.id]: {
        weeklyAvailability: [{ day: 'mon', ranges: [{ start: '08:00', end: '12:00' }] }],
        weeklyUnavailability: [],
        exceptions: [],
      },
      [medium.id]: {
        weeklyAvailability: [{ day: 'mon', ranges: [{ start: '08:00', end: '12:00' }] }],
        weeklyUnavailability: [],
        exceptions: [],
      },
      [low.id]: {
        weeklyAvailability: [{ day: 'mon', ranges: [{ start: '08:00', end: '12:00' }] }],
        weeklyUnavailability: [],
        exceptions: [],
      },
    },
    staffingRequirements: [
      { id: 'req-1', day: 'mon', start: '08:00', end: '12:00', requiredStaff: 2, role: 'Open' },
    ],
  });

  const schedule = generateSchedule(state, monday());

  assert.equal(schedule.assignments.length, 2);
  assert.equal(schedule.alerts.some((alert) => alert.kind === 'understaffed'), false);
  assert.equal(schedule.assignments.every((assignment) => assignment.day === 'mon'), true);
  assert.equal(schedule.assignments[0].employeeName, 'Ava');
  assert.equal(new Set(schedule.assignments.map((assignment) => assignment.employeeId)).size, 2);
  assert.equal(schedule.employeeHours[high.id], 4);
});

test('generateSchedule respects max weekly hours and shifts later blocks to another employee', () => {
  const capped = employee({ id: 'emp-1', name: 'Jordan', priorityLevel: 5, minPreferredWeeklyHours: 0, maxAllowedWeeklyHours: 4 });
  const backup = employee({ id: 'emp-2', name: 'Riley', priorityLevel: 1, minPreferredWeeklyHours: 0, maxAllowedWeeklyHours: 40 });

  const state = baseState({
    employees: [capped, backup],
    availability: {
      [capped.id]: {
        weeklyAvailability: [
          { day: 'mon', ranges: [{ start: '08:00', end: '12:00' }] },
          { day: 'mon', ranges: [{ start: '13:00', end: '17:00' }] },
        ],
        weeklyUnavailability: [],
        exceptions: [],
      },
      [backup.id]: {
        weeklyAvailability: [
          { day: 'mon', ranges: [{ start: '08:00', end: '12:00' }] },
          { day: 'mon', ranges: [{ start: '13:00', end: '17:00' }] },
        ],
        weeklyUnavailability: [],
        exceptions: [],
      },
    },
    staffingRequirements: [
      { id: 'req-1', day: 'mon', start: '08:00', end: '12:00', requiredStaff: 1, role: 'Open' },
      { id: 'req-2', day: 'mon', start: '13:00', end: '17:00', requiredStaff: 1, role: 'Support' },
    ],
  });

  const schedule = generateSchedule(state, monday());

  assert.equal(schedule.assignments.length, 2);
  assert.equal(schedule.employeeHours[capped.id], 4);
  assert.equal(schedule.employeeHours[backup.id], 4);
  assert.equal(schedule.alerts.some((alert) => alert.kind === 'understaffed'), false);
});

test('generateSchedule covers the most constrained shift first so later blocks still get staffed', () => {
  const flexible = employee({ id: 'emp-1', name: 'Casey', priorityLevel: 5, minPreferredWeeklyHours: 0, maxAllowedWeeklyHours: 4 });
  const constrained = employee({ id: 'emp-2', name: 'Jules', priorityLevel: 1, minPreferredWeeklyHours: 0, maxAllowedWeeklyHours: 40 });

  const state = baseState({
    employees: [flexible, constrained],
    availability: {
      [flexible.id]: {
        weeklyAvailability: [
          { day: 'mon', ranges: [{ start: '08:00', end: '12:00' }] },
          { day: 'mon', ranges: [{ start: '13:00', end: '17:00' }] },
        ],
        weeklyUnavailability: [],
        exceptions: [],
      },
      [constrained.id]: {
        weeklyAvailability: [{ day: 'mon', ranges: [{ start: '08:00', end: '12:00' }] }],
        weeklyUnavailability: [],
        exceptions: [],
      },
    },
    staffingRequirements: [
      { id: 'req-1', day: 'mon', start: '08:00', end: '12:00', requiredStaff: 1, role: 'Open' },
      { id: 'req-2', day: 'mon', start: '13:00', end: '17:00', requiredStaff: 1, role: 'Close' },
    ],
  });

  const schedule = generateSchedule(state, monday());

  assert.equal(schedule.alerts.some((alert) => alert.kind === 'understaffed'), false);
  assert.equal(schedule.assignments.length, 2);
  assert.equal(schedule.assignments.find((assignment) => assignment.start === '13:00')?.employeeName, 'Casey');
  assert.equal(schedule.assignments.find((assignment) => assignment.start === '08:00')?.employeeName, 'Jules');
});

test('generateSchedule flags understaffing when no eligible employee remains', () => {
  const emp = employee({ id: 'emp-1', name: 'Morgan', priorityLevel: 5, minPreferredWeeklyHours: 0, maxAllowedWeeklyHours: 4 });
  const state = baseState({
    employees: [emp],
    availability: {
      [emp.id]: {
        weeklyAvailability: [{ day: 'mon', ranges: [{ start: '08:00', end: '12:00' }] }],
        weeklyUnavailability: [],
        exceptions: [],
      },
    },
    staffingRequirements: [
      { id: 'req-1', day: 'mon', start: '08:00', end: '12:00', requiredStaff: 2, role: 'Open' },
    ],
  });

  const schedule = generateSchedule(state, monday());

  assert.equal(schedule.assignments.length, 1);
  assert.equal(schedule.alerts.some((alert) => alert.kind === 'understaffed'), true);
});

test('generateScheduleRange returns one generated week per requested week span', () => {
  const emp = employee({ id: 'emp-1', name: 'Sam', priorityLevel: 3, minPreferredWeeklyHours: 0, maxAllowedWeeklyHours: 40 });
  const state = baseState({
    employees: [emp],
    availability: {
      [emp.id]: {
        weeklyAvailability: [{ day: 'mon', ranges: [{ start: '08:00', end: '12:00' }] }],
        weeklyUnavailability: [],
        exceptions: [],
      },
    },
    staffingRequirements: [
      { id: 'req-1', day: 'mon', start: '08:00', end: '12:00', requiredStaff: 1, role: 'Open' },
    ],
  });

  const range = generateScheduleRange(state, new Date('2026-04-20T12:00:00'), new Date('2026-05-03T12:00:00'));

  assert.equal(range.weeks.length, 2);
  assert.equal(range.totalHours, 8);
  assert.equal(range.employeeHours[emp.id], 8);
});

test('checkScheduleFeasibility flags impossible coverage before generation', () => {
  const emp = employee({ id: 'emp-1', name: 'Alex', priorityLevel: 5, minPreferredWeeklyHours: 0, maxAllowedWeeklyHours: 4 });
  const state = baseState({
    employees: [emp],
    availability: {
      [emp.id]: {
        weeklyAvailability: [{ day: 'mon', ranges: [{ start: '08:00', end: '12:00' }] }],
        weeklyUnavailability: [],
        exceptions: [],
      },
    },
    staffingRequirements: [
      { id: 'req-1', day: 'mon', start: '08:00', end: '12:00', requiredStaff: 2, role: 'Open' },
    ],
  });

  const report = checkScheduleFeasibility(state, monday(), monday());

  assert.equal(report.feasible, false);
  assert.equal(report.issues.some((issue) => issue.kind === 'coverage' && issue.severity === 'blocking'), true);
  assert.equal(report.issues.some((issue) => issue.kind === 'capacity' && issue.severity === 'blocking'), true);
  const coverageIssue = report.issues.find((issue) => issue.kind === 'coverage');
  assert.equal(coverageIssue?.requiredStaff, 2);
  assert.equal(coverageIssue?.eligibleStaff, 1);
  assert.equal(coverageIssue?.eligibleEmployees?.[0], 'Alex');
});

test('checkScheduleFeasibility accepts a fully covered schedule', () => {
  const first = employee({ id: 'emp-1', name: 'Lena', priorityLevel: 4, minPreferredWeeklyHours: 0, maxAllowedWeeklyHours: 20 });
  const second = employee({ id: 'emp-2', name: 'Noah', priorityLevel: 3, minPreferredWeeklyHours: 0, maxAllowedWeeklyHours: 20 });
  const state = baseState({
    employees: [first, second],
    availability: {
      [first.id]: {
        weeklyAvailability: [{ day: 'mon', ranges: [{ start: '08:00', end: '12:00' }] }],
        weeklyUnavailability: [],
        exceptions: [],
      },
      [second.id]: {
        weeklyAvailability: [{ day: 'mon', ranges: [{ start: '08:00', end: '12:00' }] }],
        weeklyUnavailability: [],
        exceptions: [],
      },
    },
    staffingRequirements: [
      { id: 'req-1', day: 'mon', start: '08:00', end: '12:00', requiredStaff: 2, role: 'Open' },
    ],
  });

  const report = checkScheduleFeasibility(state, monday(), monday());

  assert.equal(report.feasible, true);
  assert.equal(report.issues.filter((issue) => issue.severity === 'blocking').length, 0);
});

test('applyScheduleOverrides lets the owner swap or clear a generated shift before publish', () => {
  const high = employee({ id: 'emp-1', name: 'Ava', priorityLevel: 5, minPreferredWeeklyHours: 0, maxAllowedWeeklyHours: 20 });
  const backup = employee({ id: 'emp-2', name: 'Ben', priorityLevel: 3, minPreferredWeeklyHours: 0, maxAllowedWeeklyHours: 20 });
  const state = baseState({
    employees: [high, backup],
    availability: {
      [high.id]: {
        weeklyAvailability: [{ day: 'mon', ranges: [{ start: '08:00', end: '12:00' }] }],
        weeklyUnavailability: [],
        exceptions: [],
      },
      [backup.id]: {
        weeklyAvailability: [{ day: 'mon', ranges: [{ start: '08:00', end: '12:00' }] }],
        weeklyUnavailability: [],
        exceptions: [],
      },
    },
    staffingRequirements: [
      { id: 'req-1', day: 'mon', start: '08:00', end: '12:00', requiredStaff: 2, role: 'Open' },
    ],
  });

  const schedule = generateSchedule(state, monday());
  const reviewed = applyScheduleOverrides(
    schedule,
    state,
    {
      [`2026-04-20:req-1:0`]: backup.id,
      [`2026-04-20:req-1:1`]: null,
    },
    monday(),
  );

  assert.equal(reviewed.assignments.length, 1);
  assert.equal(reviewed.assignments[0].employeeId, backup.id);
  assert.equal(reviewed.alerts.some((alert) => alert.kind === 'override'), true);
  assert.equal(reviewed.alerts.some((alert) => alert.kind === 'understaffed'), true);
});
