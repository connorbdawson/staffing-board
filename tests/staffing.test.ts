import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkScheduleFeasibility,
  applyScheduleOverrides,
  deriveOpenSlots,
  createTemplateFromRequirements,
  applyStaffingPatternTemplate,
  copyStaffingRequirementsFromDay,
  getScheduleStatus,
  explainEmployeeEligibilityForRequirement,
  generateSchedule,
  generateScheduleRange,
  canWorkBlock,
  weekStartMonday,
  type AppState,
  type DayKey,
  type Employee,
  type EmployeeEligibilityResult,
  type StaffingPatternTemplate,
  type StaffingRequirement,
  type OpenScheduleSlot,
} from '../lib/staffing';
import { createSeedState } from '../lib/seed';

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
    staffingPatternTemplates: overrides.staffingPatternTemplates ?? [],
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

test('createTemplateFromRequirements stores requirement data without ids and records metadata', () => {
  const requirements: StaffingRequirement[] = [
    { id: 'req-1', day: 'mon', start: '08:00', end: '12:00', requiredStaff: 2, role: 'Open', notes: 'Opening rush' },
    { id: 'req-2', day: 'tue', start: '13:00', end: '17:00', requiredStaff: 1, role: 'Close', notes: 'Late coverage' },
  ];

  const template = createTemplateFromRequirements('Busy Week', requirements);

  assert.equal(template.name, 'Busy Week');
  assert.equal(template.description, undefined);
  assert.equal(template.requirements.length, 2);
  assert.deepEqual(template.requirements[0], {
    day: 'mon',
    start: '08:00',
    end: '12:00',
    requiredStaff: 2,
    role: 'Open',
    notes: 'Opening rush',
  });
  assert.deepEqual(template.requirements[1], {
    day: 'tue',
    start: '13:00',
    end: '17:00',
    requiredStaff: 1,
    role: 'Close',
    notes: 'Late coverage',
  });
  assert.equal(typeof template.createdAt, 'string');
  assert.equal(typeof template.updatedAt, 'string');
  assert.notEqual(template.createdAt, '');
  assert.notEqual(template.updatedAt, '');
});

test('applyStaffingPatternTemplate returns fresh staffing requirement ids and preserves fields', () => {
  const template: StaffingPatternTemplate = {
    id: 'tpl-1',
    name: 'Core Week',
    description: 'Standard coverage',
    createdAt: '2026-04-20T12:00:00.000Z',
    updatedAt: '2026-04-20T12:00:00.000Z',
    requirements: [
      { day: 'mon', start: '08:00', end: '12:00', requiredStaff: 2, role: 'Open', notes: 'Opening rush' },
      { day: 'wed', start: '13:00', end: '17:00', requiredStaff: 1, role: 'Support', notes: 'Afternoon support' },
    ],
  };

  const requirements = applyStaffingPatternTemplate(template);

  assert.equal(requirements.length, 2);
  assert.equal(requirements[0]?.day, 'mon');
  assert.equal(requirements[0]?.start, '08:00');
  assert.equal(requirements[0]?.end, '12:00');
  assert.equal(requirements[0]?.requiredStaff, 2);
  assert.equal(requirements[0]?.role, 'Open');
  assert.equal(requirements[0]?.notes, 'Opening rush');
  assert.equal(requirements[1]?.day, 'wed');
  assert.equal(requirements[1]?.start, '13:00');
  assert.equal(requirements[1]?.end, '17:00');
  assert.equal(requirements[1]?.requiredStaff, 1);
  assert.equal(requirements[1]?.role, 'Support');
  assert.equal(requirements[1]?.notes, 'Afternoon support');
  assert.equal(typeof requirements[0]?.id, 'string');
  assert.equal(typeof requirements[1]?.id, 'string');
  assert.notEqual(requirements[0]?.id, '');
  assert.notEqual(requirements[1]?.id, '');
  assert.notEqual(requirements[0]?.id, requirements[1]?.id);
});

test('copyStaffingRequirementsFromDay replaces selected target days with fresh copies of the source day', () => {
  const requirements: StaffingRequirement[] = [
    { id: 'req-1', day: 'mon', start: '08:00', end: '12:00', requiredStaff: 2, role: 'Open', notes: 'Opening rush' },
    { id: 'req-2', day: 'mon', start: '13:00', end: '17:00', requiredStaff: 1, role: 'Support', notes: 'Afternoon support' },
    { id: 'req-3', day: 'tue', start: '09:00', end: '11:00', requiredStaff: 3, role: 'Tue role', notes: 'Keep this only if not targeted' },
    { id: 'req-4', day: 'fri', start: '10:00', end: '14:00', requiredStaff: 1, role: 'Fri role', notes: 'Keep this' },
  ];

  const copied = copyStaffingRequirementsFromDay(requirements, 'mon', ['tue', 'wed', 'wed']);

  assert.equal(copied.filter((requirement) => requirement.day === 'mon').length, 2);
  assert.equal(copied.filter((requirement) => requirement.day === 'tue').length, 2);
  assert.equal(copied.filter((requirement) => requirement.day === 'wed').length, 2);
  assert.equal(copied.filter((requirement) => requirement.day === 'fri').length, 1);
  assert.deepEqual(
    copied
      .filter((requirement) => requirement.day === 'tue')
      .map(({ id, ...rest }) => rest),
    [
      { day: 'tue', start: '08:00', end: '12:00', requiredStaff: 2, role: 'Open', notes: 'Opening rush' },
      { day: 'tue', start: '13:00', end: '17:00', requiredStaff: 1, role: 'Support', notes: 'Afternoon support' },
    ],
  );
  assert.equal(new Set(copied.map((requirement) => requirement.id)).size, copied.length);
});

test('getScheduleStatus returns the expected status for draft, review, ready, and published states', () => {
  const alerts = [{ id: 'a-1', kind: 'hours', message: 'Hours only' } as const];

  assert.equal(
    getScheduleStatus({
      openSlots: [] as OpenScheduleSlot[],
      alerts,
      schedulePublishedAt: null,
      updatedAt: '2026-04-25T12:00:00.000Z',
    }),
    'readyToPublish',
  );

  assert.equal(
    getScheduleStatus({
      openSlots: [
        {
          id: 'open-1',
          date: '2026-04-25',
          day: 'mon',
          blockId: 'req-1',
          slotIndex: 0,
          start: '08:00',
          end: '12:00',
          role: 'Open',
          requiredStaff: 1,
          assignedStaff: 0,
          openCount: 1,
          message: 'Needs coverage.',
        },
      ],
      alerts,
      schedulePublishedAt: null,
      updatedAt: '2026-04-25T12:00:00.000Z',
    }),
    'needsReview',
  );

  assert.equal(
    getScheduleStatus({
      openSlots: [] as OpenScheduleSlot[],
      alerts,
      schedulePublishedAt: '2026-04-25T12:00:00.000Z',
      updatedAt: '2026-04-25T11:59:59.000Z',
    }),
    'published',
  );

  assert.equal(
    getScheduleStatus({
      openSlots: [] as OpenScheduleSlot[],
      alerts,
      schedulePublishedAt: '2026-04-25T12:00:00.000Z',
      updatedAt: '2026-04-25T12:05:00.000Z',
    }),
    'draft',
  );

  assert.equal(
    getScheduleStatus({
      openSlots: [
        {
          id: 'open-1',
          date: '2026-04-25',
          day: 'mon',
          blockId: 'req-1',
          slotIndex: 0,
          start: '08:00',
          end: '12:00',
          role: 'Open',
          requiredStaff: 1,
          assignedStaff: 0,
          openCount: 1,
          message: 'Needs coverage.',
        },
      ],
      alerts,
      schedulePublishedAt: '2026-04-25T12:00:00.000Z',
      updatedAt: '2026-04-25T12:05:00.000Z',
    }),
    'needsReview',
  );
});

test('getScheduleStatus downgrades a published schedule to needsReview after edits when blocking issues remain', () => {
  const alerts = [{ id: 'a-1', kind: 'validation', message: 'Still needs attention' } as const];

  assert.equal(
    getScheduleStatus({
      openSlots: [
        {
          id: 'open-1',
          date: '2026-04-25',
          day: 'mon',
          blockId: 'req-1',
          slotIndex: 0,
          start: '08:00',
          end: '12:00',
          role: 'Open',
          requiredStaff: 1,
          assignedStaff: 0,
          openCount: 1,
          message: 'Needs coverage.',
        },
      ],
      alerts,
      schedulePublishedAt: '2026-04-25T12:00:00.000Z',
      updatedAt: '2026-04-25T12:05:00.000Z',
    }),
    'needsReview',
  );
});

test('createSeedState initializes staffing pattern templates as an empty array', () => {
  const state = createSeedState();

  assert.deepEqual(state.staffingPatternTemplates, []);
});

test('deriveOpenSlots returns no slots for a fully staffed requirement', () => {
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

  const schedule = generateSchedule(state, monday());
  const openSlots: OpenScheduleSlot[] = deriveOpenSlots(schedule, state.staffingRequirements);

  assert.equal(openSlots.length, 0);
});

test('deriveOpenSlots returns one open slot with the correct openCount when a requirement is partially staffed', () => {
  const staffed = employee({ id: 'emp-1', name: 'Ava', priorityLevel: 5, minPreferredWeeklyHours: 0, maxAllowedWeeklyHours: 20 });
  const unavailable = employee({ id: 'emp-2', name: 'Ben', priorityLevel: 3, minPreferredWeeklyHours: 0, maxAllowedWeeklyHours: 20 });
  const state = baseState({
    employees: [staffed, unavailable],
    availability: {
      [staffed.id]: {
        weeklyAvailability: [{ day: 'mon', ranges: [{ start: '08:00', end: '12:00' }] }],
        weeklyUnavailability: [],
        exceptions: [],
      },
      [unavailable.id]: {
        weeklyAvailability: [],
        weeklyUnavailability: [],
        exceptions: [],
      },
    },
    staffingRequirements: [
      { id: 'req-1', day: 'mon', start: '08:00', end: '12:00', requiredStaff: 2, role: 'Open' },
    ],
  });

  const schedule = generateSchedule(state, monday());
  const openSlots: OpenScheduleSlot[] = deriveOpenSlots(schedule, state.staffingRequirements);
  const [slot] = openSlots;

  assert.equal(openSlots.length, 1);
  assert.equal(typeof slot?.id, 'string');
  assert.notEqual(slot?.id, '');
  assert.equal(slot?.date, '2026-04-20');
  assert.equal(slot?.day, 'mon');
  assert.equal(slot?.blockId, 'req-1');
  assert.equal(slot?.slotIndex, 1);
  assert.equal(slot?.start, '08:00');
  assert.equal(slot?.end, '12:00');
  assert.equal(slot?.role, 'Open');
  assert.equal(slot?.requiredStaff, 2);
  assert.equal(slot?.assignedStaff, 1);
  assert.equal(slot?.openCount, 1);
  assert.equal(typeof slot?.message, 'string');
  assert.notEqual(slot?.message, '');
});

test('deriveOpenSlots returns one open slot with openCount equal to requiredStaff when a requirement is completely unstaffed', () => {
  const first = employee({ id: 'emp-1', name: 'Jordan', priorityLevel: 4, minPreferredWeeklyHours: 0, maxAllowedWeeklyHours: 20 });
  const second = employee({ id: 'emp-2', name: 'Riley', priorityLevel: 2, minPreferredWeeklyHours: 0, maxAllowedWeeklyHours: 20 });
  const state = baseState({
    employees: [first, second],
    availability: {
      [first.id]: {
        weeklyAvailability: [],
        weeklyUnavailability: [],
        exceptions: [],
      },
      [second.id]: {
        weeklyAvailability: [],
        weeklyUnavailability: [],
        exceptions: [],
      },
    },
    staffingRequirements: [
      { id: 'req-1', day: 'mon', start: '08:00', end: '12:00', requiredStaff: 2, role: 'Open' },
    ],
  });

  const schedule = generateSchedule(state, monday());
  const openSlots: OpenScheduleSlot[] = deriveOpenSlots(schedule, state.staffingRequirements);
  const [slot] = openSlots;

  assert.equal(openSlots.length, 1);
  assert.equal(typeof slot?.id, 'string');
  assert.notEqual(slot?.id, '');
  assert.equal(slot?.date, '2026-04-20');
  assert.equal(slot?.day, 'mon');
  assert.equal(slot?.blockId, 'req-1');
  assert.equal(slot?.slotIndex, 0);
  assert.equal(slot?.start, '08:00');
  assert.equal(slot?.end, '12:00');
  assert.equal(slot?.role, 'Open');
  assert.equal(slot?.requiredStaff, 2);
  assert.equal(slot?.assignedStaff, 0);
  assert.equal(slot?.openCount, 2);
  assert.equal(typeof slot?.message, 'string');
  assert.notEqual(slot?.message, '');
});

test('explainEmployeeEligibilityForRequirement marks availability conflicts as ineligible', () => {
  const employeeRecord = employee({ id: 'emp-1', name: 'Taylor', priorityLevel: 4, minPreferredWeeklyHours: 0, maxAllowedWeeklyHours: 40 });
  const state = baseState({
    employees: [employeeRecord],
    availability: {
      [employeeRecord.id]: {
        weeklyAvailability: [{ day: 'mon', ranges: [{ start: '08:00', end: '10:00' }] }],
        weeklyUnavailability: [],
        exceptions: [],
      },
    },
    staffingRequirements: [{ id: 'req-1', day: 'mon', start: '10:00', end: '12:00', requiredStaff: 1, role: 'Open' }],
  });

  const results: EmployeeEligibilityResult[] = explainEmployeeEligibilityForRequirement({
    state,
    requirement: state.staffingRequirements[0],
    weekStart: monday(),
    currentAssignments: [],
    employeeHours: {},
  });

  assert.equal(results.length, 1);
  assert.equal(results[0]?.eligible, false);
  assert.equal(results[0]?.reason, 'Outside weekly availability.');
});

test('explainEmployeeEligibilityForRequirement marks max weekly hours conflicts as ineligible', () => {
  const employeeRecord = employee({ id: 'emp-1', name: 'Jordan', priorityLevel: 4, minPreferredWeeklyHours: 0, maxAllowedWeeklyHours: 4 });
  const state = baseState({
    employees: [employeeRecord],
    availability: {
      [employeeRecord.id]: {
        weeklyAvailability: [{ day: 'mon', ranges: [{ start: '08:00', end: '12:00' }] }],
        weeklyUnavailability: [],
        exceptions: [],
      },
    },
    staffingRequirements: [{ id: 'req-1', day: 'mon', start: '08:00', end: '12:00', requiredStaff: 1, role: 'Open' }],
  });

  const results: EmployeeEligibilityResult[] = explainEmployeeEligibilityForRequirement({
    state,
    requirement: state.staffingRequirements[0],
    weekStart: monday(),
    currentAssignments: [],
    employeeHours: { [employeeRecord.id]: 3 },
  });

  assert.equal(results.length, 1);
  assert.equal(results[0]?.eligible, false);
  assert.equal(results[0]?.reason, 'Would exceed max weekly hours.');
});

test('explainEmployeeEligibilityForRequirement marks scheduled overlap as ineligible', () => {
  const employeeRecord = employee({ id: 'emp-1', name: 'Mia', priorityLevel: 4, minPreferredWeeklyHours: 0, maxAllowedWeeklyHours: 40 });
  const state = baseState({
    employees: [employeeRecord],
    availability: {
      [employeeRecord.id]: {
        weeklyAvailability: [{ day: 'mon', ranges: [{ start: '08:00', end: '18:00' }] }],
        weeklyUnavailability: [],
        exceptions: [],
      },
    },
    staffingRequirements: [{ id: 'req-1', day: 'mon', start: '10:00', end: '14:00', requiredStaff: 1, role: 'Open' }],
  });

  const results: EmployeeEligibilityResult[] = explainEmployeeEligibilityForRequirement({
    state,
    requirement: state.staffingRequirements[0],
    weekStart: monday(),
    currentAssignments: [{ employeeId: employeeRecord.id, day: 'mon', start: '08:00', end: '12:00' }],
    employeeHours: { [employeeRecord.id]: 4 },
  });

  assert.equal(results.length, 1);
  assert.equal(results[0]?.eligible, false);
  assert.equal(results[0]?.reason, 'Employee is already scheduled in this time block.');
});

test('explainEmployeeEligibilityForRequirement sorts eligible employees by score, priority, and name before ineligible employees', () => {
  const ben = employee({ id: 'emp-1', name: 'Ben', priorityLevel: 5, minPreferredWeeklyHours: 0, maxAllowedWeeklyHours: 100 });
  const aaron = employee({ id: 'emp-2', name: 'Aaron', priorityLevel: 4, minPreferredWeeklyHours: 1, maxAllowedWeeklyHours: 100 });
  const ava = employee({ id: 'emp-3', name: 'Ava', priorityLevel: 4, minPreferredWeeklyHours: 1, maxAllowedWeeklyHours: 100 });
  const zoe = employee({ id: 'emp-4', name: 'Zoe', priorityLevel: 4, minPreferredWeeklyHours: 1, maxAllowedWeeklyHours: 100 });
  const erin = employee({ id: 'emp-5', name: 'Erin', priorityLevel: 2, minPreferredWeeklyHours: 0, maxAllowedWeeklyHours: 100 });
  const state = baseState({
    employees: [ben, aaron, ava, zoe, erin],
    availability: {
      [ben.id]: {
        weeklyAvailability: [{ day: 'mon', ranges: [{ start: '08:00', end: '12:00' }] }],
        weeklyUnavailability: [],
        exceptions: [],
      },
      [aaron.id]: {
        weeklyAvailability: [{ day: 'mon', ranges: [{ start: '08:00', end: '12:00' }] }],
        weeklyUnavailability: [],
        exceptions: [],
      },
      [ava.id]: {
        weeklyAvailability: [{ day: 'mon', ranges: [{ start: '08:00', end: '12:00' }] }],
        weeklyUnavailability: [],
        exceptions: [],
      },
      [zoe.id]: {
        weeklyAvailability: [{ day: 'mon', ranges: [{ start: '08:00', end: '12:00' }] }],
        weeklyUnavailability: [],
        exceptions: [],
      },
      [erin.id]: {
        weeklyAvailability: [],
        weeklyUnavailability: [],
        exceptions: [],
      },
    },
    staffingRequirements: [{ id: 'req-1', day: 'mon', start: '08:00', end: '12:00', requiredStaff: 1, role: 'Open' }],
  });

  const results: EmployeeEligibilityResult[] = explainEmployeeEligibilityForRequirement({
    state,
    requirement: state.staffingRequirements[0],
    weekStart: monday(),
    currentAssignments: [],
    employeeHours: {
      [ben.id]: 0,
      [aaron.id]: 64,
      [ava.id]: 64,
      [zoe.id]: 64,
      [erin.id]: 0,
    },
  });

  assert.equal(results.length, 5);
  assert.deepEqual(
    results.map((result) => result.employeeName),
    ['Ben', 'Aaron', 'Ava', 'Zoe', 'Erin'],
  );
  assert.deepEqual(results.slice(0, 4).map((result) => result.eligible), [true, true, true, true]);
  assert.equal(results[4]?.eligible, false);
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
