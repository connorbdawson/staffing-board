export const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type DayKey = (typeof DAYS)[number];

export type TimeRange = {
  start: string;
  end: string;
};

export type WeeklyRule = {
  day: DayKey;
  ranges: TimeRange[];
};

export type DateException = {
  id: string;
  date: string;
  type: 'available' | 'unavailable';
  start: string;
  end: string;
  notes?: string;
};

export type Employee = {
  id: string;
  name: string;
  role: string;
  hourlyWage: number;
  minPreferredWeeklyHours: number;
  maxAllowedWeeklyHours: number;
  priorityLevel: number;
  active: boolean;
  notes: string;
};

export type EmployeeAvailability = {
  weeklyAvailability: WeeklyRule[];
  weeklyUnavailability: WeeklyRule[];
  exceptions: DateException[];
};

export type BusinessHours = WeeklyRule;

export type StaffingRequirement = {
  id: string;
  day: DayKey;
  start: string;
  end: string;
  requiredStaff: number;
  role?: string;
  notes?: string;
};

export type AppState = {
  employees: Employee[];
  availability: Record<string, EmployeeAvailability>;
  businessHours: BusinessHours[];
  staffingRequirements: StaffingRequirement[];
  scheduleOverrides: Record<string, string | null>;
  schedulePublishedAt: string | null;
  updatedAt: string;
};

export type ScheduleAssignment = {
  id: string;
  slotIndex: number;
  day: DayKey;
  date: string;
  start: string;
  end: string;
  employeeId: string;
  employeeName: string;
  role: string;
  hourlyWage: number;
  cost: number;
  blockId: string;
  requiredStaff: number;
};

export type ScheduleAlert = {
  id: string;
  kind: 'understaffed' | 'availability' | 'validation' | 'hours' | 'override';
  day?: DayKey;
  date?: string;
  message: string;
};

export type GeneratedSchedule = {
  assignments: ScheduleAssignment[];
  alerts: ScheduleAlert[];
  employeeHours: Record<string, number>;
  employeeCost: Record<string, number>;
  dayCost: Record<DayKey, number>;
  totalCost: number;
  daySummaries: Record<
    DayKey,
    {
      totalRequired: number;
      totalAssigned: number;
      blocks: StaffingRequirement[];
    }
  >;
};

const DAY_LABELS: Record<DayKey, string> = {
  mon: 'Mon',
  tue: 'Tue',
  wed: 'Wed',
  thu: 'Thu',
  fri: 'Fri',
  sat: 'Sat',
  sun: 'Sun',
};

export const DAY_FULL_LABELS: Record<DayKey, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};

export function dayLabel(day: DayKey) {
  return DAY_LABELS[day];
}

export function dayFullLabel(day: DayKey) {
  return DAY_FULL_LABELS[day];
}

export function uuid(prefix = 'id') {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

export function parseTime(value: string) {
  const [hours, minutes = '0'] = value.split(':');
  const h = Number(hours);
  const m = Number(minutes);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

export function formatTime(totalMinutes: number) {
  const minutes = ((totalMinutes % 1440) + 1440) % 1440;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  const suffix = hours >= 12 ? 'PM' : 'AM';
  const displayHour = hours % 12 === 0 ? 12 : hours % 12;
  return `${displayHour}:${mins.toString().padStart(2, '0')} ${suffix}`;
}

export function durationHours(start: string, end: string) {
  const startMinutes = parseTime(start);
  const endMinutes = parseTime(end);
  if (startMinutes === null || endMinutes === null || endMinutes <= startMinutes) {
    return 0;
  }
  return (endMinutes - startMinutes) / 60;
}

export function formatCurrency(amount: number) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(amount);
}

export function isoDateForWeekDay(weekStart: Date, day: DayKey) {
  const index = DAYS.indexOf(day);
  const result = new Date(weekStart);
  result.setHours(12, 0, 0, 0);
  result.setDate(result.getDate() + index);
  return result.toISOString().slice(0, 10);
}

export function weekStartMonday(date: Date) {
  const result = new Date(date);
  result.setHours(12, 0, 0, 0);
  const day = result.getDay();
  const delta = day === 0 ? -6 : 1 - day;
  result.setDate(result.getDate() + delta);
  return result;
}

export function addDays(date: Date, days: number) {
  const result = new Date(date);
  result.setHours(12, 0, 0, 0);
  result.setDate(result.getDate() + days);
  return result;
}

export function overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string) {
  const a1 = parseTime(aStart);
  const a2 = parseTime(aEnd);
  const b1 = parseTime(bStart);
  const b2 = parseTime(bEnd);
  if (a1 === null || a2 === null || b1 === null || b2 === null) return false;
  return Math.max(a1, b1) < Math.min(a2, b2);
}

export function containsRange(containerStart: string, containerEnd: string, innerStart: string, innerEnd: string) {
  const a1 = parseTime(containerStart);
  const a2 = parseTime(containerEnd);
  const b1 = parseTime(innerStart);
  const b2 = parseTime(innerEnd);
  if (a1 === null || a2 === null || b1 === null || b2 === null) return false;
  return a1 <= b1 && a2 >= b2;
}

function rulesForDay(rules: WeeklyRule[], day: DayKey) {
  return rules.filter((rule) => rule.day === day);
}

function blockWithinRules(block: { day: DayKey; start: string; end: string }, rules: WeeklyRule[]) {
  return rulesForDay(rules, block.day).some((rule) => rule.ranges.some((range) => containsRange(range.start, range.end, block.start, block.end)));
}

function blockIntersectsRules(block: { day: DayKey; start: string; end: string }, rules: WeeklyRule[]) {
  return rulesForDay(rules, block.day).some((rule) => rule.ranges.some((range) => overlaps(range.start, range.end, block.start, block.end)));
}

export function canWorkBlock(
  employeeId: string,
  block: { day: DayKey; start: string; end: string; date: string },
  state: AppState,
  assignedBlocks: Array<{ employeeId: string; day: DayKey; start: string; end: string }>,
) {
  const employeeAvailability = state.availability[employeeId] ?? {
    weeklyAvailability: [],
    weeklyUnavailability: [],
    exceptions: [],
  };
  const blockMinutes = durationHours(block.start, block.end);
  if (blockMinutes <= 0) return { allowed: false, reason: 'Invalid block time.' };

  const exception = employeeAvailability.exceptions.find((entry) => entry.date === block.date && containsRange(entry.start, entry.end, block.start, block.end));
  if (exception?.type === 'unavailable') {
    return { allowed: false, reason: 'Employee has a date exception marked unavailable.' };
  }

  if (!blockWithinRules(block, state.businessHours)) {
    return { allowed: false, reason: 'Outside business hours.' };
  }

  // A one-time available exception is allowed to override the regular weekly windows.
  if (exception?.type === 'available') {
    const overlap = assignedBlocks.some(
      (entry) => entry.employeeId === employeeId && entry.day === block.day && overlaps(entry.start, entry.end, block.start, block.end),
    );
    if (overlap) {
      return { allowed: false, reason: 'Employee is already scheduled in this time block.' };
    }
    return { allowed: true, reason: '' };
  }

  if (blockIntersectsRules(block, employeeAvailability.weeklyUnavailability)) {
    return { allowed: false, reason: 'Conflicts with weekly unavailability.' };
  }

  if (!blockWithinRules(block, employeeAvailability.weeklyAvailability)) {
    return { allowed: false, reason: 'Outside weekly availability.' };
  }

  const overlap = assignedBlocks.some(
    (entry) => entry.employeeId === employeeId && entry.day === block.day && overlaps(entry.start, entry.end, block.start, block.end),
  );
  if (overlap) {
    return { allowed: false, reason: 'Employee is already scheduled in this time block.' };
  }

  return { allowed: true, reason: '' };
}

export function validateState(state: AppState) {
  const warnings: string[] = [];

  state.employees.forEach((employee) => {
    if (!employee.name.trim()) warnings.push(`Employee ${employee.id} is missing a name.`);
    if (employee.hourlyWage <= 0) warnings.push(`${employee.name || employee.id} has an invalid hourly wage.`);
    if (employee.minPreferredWeeklyHours < 0 || employee.maxAllowedWeeklyHours < 0) {
      warnings.push(`${employee.name || employee.id} has negative hour limits.`);
    }
    if (employee.minPreferredWeeklyHours > employee.maxAllowedWeeklyHours) {
      warnings.push(`${employee.name || employee.id} has min preferred hours above max allowed hours.`);
    }
    if (employee.priorityLevel < 1 || employee.priorityLevel > 5) {
      warnings.push(`${employee.name || employee.id} should use a priority level from 1 to 5.`);
    }
  });

  state.businessHours.forEach((rule) => {
    rule.ranges.forEach((range) => {
      if (parseTime(range.start) === null || parseTime(range.end) === null || durationHours(range.start, range.end) <= 0) {
        warnings.push(`${DAY_FULL_LABELS[rule.day]} business hours contain an invalid time range.`);
      }
    });
  });

  state.staffingRequirements.forEach((requirement) => {
    if (requirement.requiredStaff < 1) {
      warnings.push(`${DAY_FULL_LABELS[requirement.day]} ${requirement.start}-${requirement.end} requires at least one staff member.`);
    }
    if (durationHours(requirement.start, requirement.end) <= 0) {
      warnings.push(`${DAY_FULL_LABELS[requirement.day]} ${requirement.start}-${requirement.end} has an invalid time range.`);
    }
  });

  return warnings;
}

export function generateSchedule(state: AppState, weekStart: Date): GeneratedSchedule {
  const assignments: ScheduleAssignment[] = [];
  const alerts: ScheduleAlert[] = [];
  const employeeHours: Record<string, number> = {};
  const employeeCost: Record<string, number> = {};
  const dayCost = DAYS.reduce((acc, day) => {
    acc[day] = 0;
    return acc;
  }, {} as Record<DayKey, number>);
  const scheduledBlocks: Array<{ employeeId: string; day: DayKey; start: string; end: string }> = [];
  const daySummaries = DAYS.reduce((acc, day) => {
    acc[day] = {
      totalRequired: 0,
      totalAssigned: 0,
      blocks: [] as StaffingRequirement[],
    };
    return acc;
  }, {} as GeneratedSchedule['daySummaries']);

  const remainingRequirements = [...state.staffingRequirements];

  while (remainingRequirements.length > 0) {
    const requirement = sortRequirementsByConstraint(remainingRequirements, state, employeeHours, scheduledBlocks, weekStart)[0];
    const requirementIndex = remainingRequirements.findIndex((entry) => entry.id === requirement.id);
    if (requirementIndex >= 0) {
      remainingRequirements.splice(requirementIndex, 1);
    }

    const date = isoDateForWeekDay(weekStart, requirement.day);
    const blockHours = durationHours(requirement.start, requirement.end);
    daySummaries[requirement.day].totalRequired += requirement.requiredStaff;
    daySummaries[requirement.day].blocks.push(requirement);

    if (blockHours <= 0) {
      alerts.push({
        id: uuid('alert'),
        kind: 'validation',
        day: requirement.day,
        date,
        message: `${dayFullLabel(requirement.day)} ${requirement.start} - ${requirement.end} has an invalid time range.`,
      });
      continue;
    }

    if (!blockWithinRules(requirement, state.businessHours)) {
      alerts.push({
        id: uuid('alert'),
        kind: 'validation',
        day: requirement.day,
        date,
        message: `${dayFullLabel(requirement.day)} ${requirement.start} - ${requirement.end} sits outside business hours.`,
      });
    }

    const scoredCandidates = eligibleEmployeesForRequirement(requirement, state, employeeHours, scheduledBlocks, weekStart);
    if (!scoredCandidates.length) {
      alerts.push({
        id: uuid('alert'),
        kind: 'understaffed',
        day: requirement.day,
        date,
        message: `${dayFullLabel(requirement.day)} ${requirement.start} - ${requirement.end} is understaffed by ${requirement.requiredStaff} employee(s).`,
      });
      continue;
    }

    const picks = chooseBestEmployeeSet(scoredCandidates, Math.min(requirement.requiredStaff, scoredCandidates.length));
    if (!picks.length) {
      alerts.push({
        id: uuid('alert'),
        kind: 'understaffed',
        day: requirement.day,
        date,
        message: `${dayFullLabel(requirement.day)} ${requirement.start} - ${requirement.end} is understaffed by ${requirement.requiredStaff} employee(s).`,
      });
      continue;
    }

    picks.forEach((pick, slotIndex) => {
      const hours = employeeHours[pick.employee.id] ?? 0;
      const cost = blockHours * pick.employee.hourlyWage;
      employeeHours[pick.employee.id] = hours + blockHours;
      employeeCost[pick.employee.id] = (employeeCost[pick.employee.id] ?? 0) + cost;
      dayCost[requirement.day] += cost;
      daySummaries[requirement.day].totalAssigned += 1;

      assignments.push({
        id: uuid('assignment'),
        slotIndex,
        day: requirement.day,
        date,
        start: requirement.start,
        end: requirement.end,
        employeeId: pick.employee.id,
        employeeName: pick.employee.name,
        role: pick.employee.role,
        hourlyWage: pick.employee.hourlyWage,
        cost,
        blockId: requirement.id,
        requiredStaff: requirement.requiredStaff,
      });
      scheduledBlocks.push({
        employeeId: pick.employee.id,
        day: requirement.day,
        start: requirement.start,
        end: requirement.end,
      });
    });

    if (picks.length < requirement.requiredStaff) {
      alerts.push({
        id: uuid('alert'),
        kind: 'understaffed',
        day: requirement.day,
        date,
        message: `${dayFullLabel(requirement.day)} ${requirement.start} - ${requirement.end} is understaffed by ${requirement.requiredStaff - picks.length} employee(s).`,
      });
    }
  }

  state.employees.forEach((employee) => {
    if (!employee.active) return;
    const hours = employeeHours[employee.id] ?? 0;
    if (hours < employee.minPreferredWeeklyHours) {
      alerts.push({
        id: uuid('alert'),
        kind: 'hours',
        message: `${employee.name} is scheduled for ${hours.toFixed(1)} hours, which is below the preferred minimum of ${employee.minPreferredWeeklyHours}.`,
      });
    }
  });

  const totalCost = Object.values(employeeCost).reduce((sum, value) => sum + value, 0);

  return {
    assignments,
    alerts,
    employeeHours,
    employeeCost,
    dayCost,
    totalCost,
    daySummaries,
  };
}

export type GeneratedScheduleRange = {
  weeks: Array<{
    weekStart: Date;
    weekEnd: Date;
    schedule: GeneratedSchedule;
  }>;
  alerts: ScheduleAlert[];
  employeeHours: Record<string, number>;
  employeeCost: Record<string, number>;
  totalCost: number;
};

export type ScheduleFeasibilityIssue = {
  kind: 'configuration' | 'coverage' | 'capacity';
  severity: 'warning' | 'blocking';
  message: string;
  day?: DayKey;
  date?: string;
  requiredStaff?: number;
  eligibleStaff?: number;
  eligibleEmployees?: string[];
};

export type ScheduleOverrideMap = Record<string, string | null>;

export type ScheduleFeasibilityReport = {
  feasible: boolean;
  totalRequiredHours: number;
  estimatedCapacityHours: number;
  coverageRatio: number;
  issueCount: number;
  issues: ScheduleFeasibilityIssue[];
};

function normalizeIntervals(intervals: Array<{ start: number; end: number }>) {
  const parsed = intervals
    .filter((interval) => interval.end > interval.start)
    .sort((a, b) => a.start - b.start);

  const merged: Array<{ start: number; end: number }> = [];
  for (const interval of parsed) {
    const last = merged[merged.length - 1];
    if (!last || interval.start > last.end) {
      merged.push({ ...interval });
    } else {
      last.end = Math.max(last.end, interval.end);
    }
  }
  return merged;
}

function subtractIntervals(base: Array<{ start: number; end: number }>, remove: Array<{ start: number; end: number }>) {
  let result = [...base];
  for (const removal of remove) {
    const next: Array<{ start: number; end: number }> = [];
    for (const interval of result) {
      if (removal.end <= interval.start || removal.start >= interval.end) {
        next.push(interval);
        continue;
      }
      if (removal.start > interval.start) {
        next.push({ start: interval.start, end: removal.start });
      }
      if (removal.end < interval.end) {
        next.push({ start: removal.end, end: interval.end });
      }
    }
    result = next;
  }
  return result;
}

function dayIntervalsFromRules(rules: WeeklyRule[], day: DayKey) {
  return normalizeIntervals(
    rules
      .filter((rule) => rule.day === day)
      .flatMap((rule) =>
        rule.ranges
          .map((range) => ({
            start: parseTime(range.start),
            end: parseTime(range.end),
          }))
          .filter((interval): interval is { start: number; end: number } => interval.start !== null && interval.end !== null),
      ),
  );
}

function dayAvailableMinutes(state: AppState, employeeId: string, day: DayKey) {
  const availability = state.availability[employeeId] ?? {
    weeklyAvailability: [],
    weeklyUnavailability: [],
    exceptions: [],
  };
  const business = dayIntervalsFromRules(state.businessHours, day);
  const allowed = dayIntervalsFromRules(availability.weeklyAvailability, day);
  const blocked = dayIntervalsFromRules(availability.weeklyUnavailability, day);

  const intersections = business.flatMap((businessRange) =>
    allowed
      .filter((availabilityRange) => Math.max(businessRange.start, availabilityRange.start) < Math.min(businessRange.end, availabilityRange.end))
      .map((availabilityRange) => ({
        start: Math.max(businessRange.start, availabilityRange.start),
        end: Math.min(businessRange.end, availabilityRange.end),
      })),
  );

  const available = subtractIntervals(normalizeIntervals(intersections), blocked);
  return available.reduce((sum, range) => sum + (range.end - range.start), 0);
}

export function estimateWeeklyAvailableHours(state: AppState, employeeId: string) {
  return DAYS.reduce((sum, day) => sum + dayAvailableMinutes(state, employeeId, day), 0) / 60;
}

function candidateScore(employee: Employee, hoursSoFar: number) {
  const minGap = Math.max(0, employee.minPreferredWeeklyHours - hoursSoFar);
  const priorityBoost = employee.priorityLevel * 100;
  const deficitBoost = minGap > 0 ? 1000 + minGap * 60 : 0;
  const loadPenalty = hoursSoFar * 15;
  const wagePenalty = employee.hourlyWage * 0.5;
  return priorityBoost + deficitBoost - loadPenalty - wagePenalty;
}

function canEmployeeCoverRequirement(
  employee: Employee,
  requirement: StaffingRequirement,
  state: AppState,
  currentHours: number,
  assignedBlocks: Array<{ employeeId: string; day: DayKey; start: string; end: string }>,
  date: string,
) {
  if (!employee.active) return false;
  if (currentHours + durationHours(requirement.start, requirement.end) > employee.maxAllowedWeeklyHours) return false;
  return canWorkBlock(employee.id, { day: requirement.day, start: requirement.start, end: requirement.end, date }, state, assignedBlocks).allowed;
}

function eligibleEmployeesForRequirement(
  requirement: StaffingRequirement,
  state: AppState,
  currentHours: Record<string, number>,
  assignedBlocks: Array<{ employeeId: string; day: DayKey; start: string; end: string }>,
  weekStart: Date,
) {
  const date = isoDateForWeekDay(weekStart, requirement.day);
  return state.employees
    .filter((employee) => canEmployeeCoverRequirement(employee, requirement, state, currentHours[employee.id] ?? 0, assignedBlocks, date))
    .map((employee) => ({
      employee,
      score: candidateScore(employee, currentHours[employee.id] ?? 0),
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.employee.priorityLevel !== a.employee.priorityLevel) return b.employee.priorityLevel - a.employee.priorityLevel;
      return a.employee.hourlyWage - b.employee.hourlyWage;
    });
}

function chooseBestEmployeeSet(
  candidates: Array<{ employee: Employee; score: number }>,
  slotsNeeded: number,
) {
  const sorted = [...candidates].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.employee.priorityLevel !== a.employee.priorityLevel) return b.employee.priorityLevel - a.employee.priorityLevel;
    return a.employee.hourlyWage - b.employee.hourlyWage;
  });

  let best: Array<{ employee: Employee; score: number }> = [];
  let bestScore = Number.NEGATIVE_INFINITY;
  const suffixSums = new Array<number>(sorted.length + 1).fill(0);
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    suffixSums[index] = suffixSums[index + 1] + Math.max(0, sorted[index].score);
  }

  function search(index: number, picked: Array<{ employee: Employee; score: number }>, score: number) {
    if (picked.length === slotsNeeded) {
      if (score > bestScore) {
        bestScore = score;
        best = [...picked];
      }
      return;
    }

    if (index >= sorted.length) return;

    const remainingNeeded = slotsNeeded - picked.length;
    const remainingCandidates = sorted.length - index;
    if (remainingCandidates < remainingNeeded) return;

    const optimistic = score + suffixSums[index];
    if (optimistic <= bestScore) return;

    search(index + 1, [...picked, sorted[index]], score + sorted[index].score);
    search(index + 1, picked, score);
  }

  search(0, [], 0);
  return best;
}

function sortRequirementsByConstraint(
  requirements: StaffingRequirement[],
  state: AppState,
  currentHours: Record<string, number>,
  assignedBlocks: Array<{ employeeId: string; day: DayKey; start: string; end: string }>,
  weekStart: Date,
) {
  return [...requirements].sort((a, b) => {
    const eligibleA = eligibleEmployeesForRequirement(a, state, currentHours, assignedBlocks, weekStart).length;
    const eligibleB = eligibleEmployeesForRequirement(b, state, currentHours, assignedBlocks, weekStart).length;
    if (eligibleA !== eligibleB) return eligibleA - eligibleB;

    if (a.requiredStaff !== b.requiredStaff) return b.requiredStaff - a.requiredStaff;

    const dayDiff = DAYS.indexOf(a.day) - DAYS.indexOf(b.day);
    if (dayDiff !== 0) return dayDiff;

    const timeDiff = (parseTime(a.start) ?? 0) - (parseTime(b.start) ?? 0);
    if (timeDiff !== 0) return timeDiff;

    return durationHours(b.start, b.end) - durationHours(a.start, a.end);
  });
}

export function checkScheduleFeasibility(state: AppState, startDate: Date, endDate: Date): ScheduleFeasibilityReport {
  const issues: ScheduleFeasibilityIssue[] = [];
  const weeks = Math.max(1, Math.round((weekStartMonday(endDate).getTime() - weekStartMonday(startDate).getTime()) / (7 * 24 * 60 * 60 * 1000)) + 1);
  const validationWarnings = validateState(state);
  validationWarnings.forEach((message) => {
    issues.push({
      kind: 'configuration',
      severity: 'warning',
      message,
    });
  });

  let totalRequiredHours = 0;
  const weeklyEmployeeCapacity = new Map<string, number>();

  for (const requirement of state.staffingRequirements) {
    const blockHours = durationHours(requirement.start, requirement.end);
    totalRequiredHours += blockHours * requirement.requiredStaff * weeks;

    if (!blockWithinRules(requirement, state.businessHours)) {
      issues.push({
        kind: 'configuration',
        severity: 'blocking',
        day: requirement.day,
        message: `${DAY_FULL_LABELS[requirement.day]} ${requirement.start} - ${requirement.end} sits outside business hours.`,
      });
    }

    const date = isoDateForWeekDay(weekStartMonday(startDate), requirement.day);
    const eligibleEmployees = state.employees
      .filter((employee) => canEmployeeCoverRequirement(employee, requirement, state, 0, [], date))
      .map((employee) => employee.name);
    const eligibleCount = eligibleEmployees.length;

    if (eligibleCount < requirement.requiredStaff) {
      issues.push({
        kind: 'coverage',
        severity: 'blocking',
        day: requirement.day,
        requiredStaff: requirement.requiredStaff,
        eligibleStaff: eligibleCount,
        eligibleEmployees,
        message: `${DAY_FULL_LABELS[requirement.day]} ${requirement.start} - ${requirement.end} needs ${requirement.requiredStaff} employee(s), but only ${eligibleCount} can cover it.${eligibleEmployees.length ? ` Eligible: ${eligibleEmployees.join(', ')}` : ' Eligible: none.'}`,
      });
    }
  }

  const activeEmployees = state.employees.filter((employee) => employee.active);
  for (const employee of activeEmployees) {
    const weeklyAvailableHours = estimateWeeklyAvailableHours(state, employee.id);
    weeklyEmployeeCapacity.set(employee.id, Math.min(employee.maxAllowedWeeklyHours, weeklyAvailableHours));
  }

  const estimatedCapacityHours = Array.from(weeklyEmployeeCapacity.values()).reduce((sum, value) => sum + value, 0) * weeks;

  if (estimatedCapacityHours < totalRequiredHours) {
    issues.push({
      kind: 'capacity',
      severity: 'blocking',
      message: `The requested period needs about ${totalRequiredHours.toFixed(1)} labor hours, but the current employee pool can cover only about ${estimatedCapacityHours.toFixed(1)} hours.`,
    });
  }

  const blockingIssues = issues.filter((issue) => issue.severity === 'blocking').length;
  return {
    feasible: blockingIssues === 0,
    totalRequiredHours,
    estimatedCapacityHours,
    coverageRatio: totalRequiredHours > 0 ? estimatedCapacityHours / totalRequiredHours : 1,
    issueCount: issues.length,
    issues,
  };
}

export function generateScheduleRange(state: AppState, startDate: Date, endDate: Date): GeneratedScheduleRange {
  const start = weekStartMonday(startDate);
  const end = weekStartMonday(endDate);
  const weeks: GeneratedScheduleRange['weeks'] = [];
  const alerts: ScheduleAlert[] = [];
  const employeeHours: Record<string, number> = {};
  const employeeCost: Record<string, number> = {};
  let totalCost = 0;

  let cursor = start;
  while (cursor <= end) {
    const schedule = generateSchedule(state, cursor);
    weeks.push({
      weekStart: new Date(cursor),
      weekEnd: addDays(cursor, 6),
      schedule,
    });
    alerts.push(...schedule.alerts);
    totalCost += schedule.totalCost;

    for (const [employeeId, hours] of Object.entries(schedule.employeeHours)) {
      employeeHours[employeeId] = (employeeHours[employeeId] ?? 0) + hours;
    }

    for (const [employeeId, cost] of Object.entries(schedule.employeeCost)) {
      employeeCost[employeeId] = (employeeCost[employeeId] ?? 0) + cost;
    }

    cursor = addDays(cursor, 7);
  }

  return {
    weeks,
    alerts,
    employeeHours,
    employeeCost,
    totalCost,
  };
}

export function scheduleAssignmentKey(assignment: Pick<ScheduleAssignment, 'date' | 'blockId' | 'slotIndex'>) {
  return `${assignment.date}:${assignment.blockId}:${assignment.slotIndex}`;
}

function cloneDaySummaries(daySummaries: GeneratedSchedule['daySummaries']) {
  return DAYS.reduce((acc, day) => {
    acc[day] = {
      totalRequired: daySummaries[day].totalRequired,
      totalAssigned: 0,
      blocks: [...daySummaries[day].blocks],
    };
    return acc;
  }, {} as GeneratedSchedule['daySummaries']);
}

function addScheduleAlert(issues: ScheduleAlert[], message: string, kind: ScheduleAlert['kind'], day?: DayKey, date?: string) {
  issues.push({
    id: uuid('alert'),
    kind,
    day,
    date,
    message,
  });
}

function findEmployeeById(state: AppState, employeeId: string) {
  return state.employees.find((employee) => employee.id === employeeId && employee.active);
}

export function applyScheduleOverrides(
  schedule: GeneratedSchedule,
  state: AppState,
  overrides: ScheduleOverrideMap,
  weekStart: Date,
) {
  const assignmentsByBlock = new Map<string, ScheduleAssignment[]>();
  schedule.assignments.forEach((assignment) => {
    const current = assignmentsByBlock.get(assignment.blockId) ?? [];
    current.push(assignment);
    assignmentsByBlock.set(assignment.blockId, current);
  });

  const reviewState = {
    scheduledBlocks: [] as Array<{ employeeId: string; day: DayKey; start: string; end: string }>,
    employeeHours: {} as Record<string, number>,
    employeeCost: {} as Record<string, number>,
    dayCost: DAYS.reduce((acc, day) => {
      acc[day] = 0;
      return acc;
    }, {} as Record<DayKey, number>),
    daySummaries: cloneDaySummaries(schedule.daySummaries),
    alerts: [] as ScheduleAlert[],
    assignments: [] as ScheduleAssignment[],
  };

  state.staffingRequirements.forEach((block) => {
    const date = isoDateForWeekDay(weekStart, block.day);
    const blockAssignments = assignmentsByBlock.get(block.id) ?? [];
    const assignmentsBySlot = new Map(blockAssignments.map((assignment) => [assignment.slotIndex, assignment]));

    if (durationHours(block.start, block.end) <= 0 || !blockWithinRules(block, state.businessHours)) {
      addScheduleAlert(
        reviewState.alerts,
        `${DAY_FULL_LABELS[block.day]} ${block.start} - ${block.end} sits outside business hours.`,
        'validation',
        block.day,
        date,
      );
    }

    for (let slotIndex = 0; slotIndex < block.requiredStaff; slotIndex += 1) {
      const baseAssignment = assignmentsBySlot.get(slotIndex);
      const overrideKey = scheduleAssignmentKey({
        date,
        blockId: block.id,
        slotIndex,
      });
      const overrideValue = Object.prototype.hasOwnProperty.call(overrides, overrideKey) ? overrides[overrideKey] : undefined;
      const targetEmployeeId = overrideValue === null ? null : overrideValue ?? baseAssignment?.employeeId ?? null;
      const employee = targetEmployeeId ? findEmployeeById(state, targetEmployeeId) : null;
      const blockHours = durationHours(block.start, block.end);

      if (targetEmployeeId === null) {
        addScheduleAlert(
          reviewState.alerts,
          `${DAY_FULL_LABELS[block.day]} ${block.start} - ${block.end} slot ${slotIndex + 1} was cleared before publish.`,
          'override',
          block.day,
          date,
        );
        continue;
      }

      if (!employee) {
        if (overrideValue !== undefined) {
          addScheduleAlert(
            reviewState.alerts,
            `${DAY_FULL_LABELS[block.day]} ${block.start} - ${block.end} slot ${slotIndex + 1} could not be reassigned because the selected employee is inactive or missing.`,
            'override',
            block.day,
            date,
          );
        }
        if (!baseAssignment) continue;
      }

      const finalEmployee = employee ?? (baseAssignment ? findEmployeeById(state, baseAssignment.employeeId) : null);
      if (!finalEmployee) continue;

      const hoursSoFar = reviewState.employeeHours[finalEmployee.id] ?? 0;
      const allowed = canWorkBlock(finalEmployee.id, { day: block.day, start: block.start, end: block.end, date }, state, reviewState.scheduledBlocks);
      if (!allowed.allowed) {
        addScheduleAlert(
          reviewState.alerts,
          `${DAY_FULL_LABELS[block.day]} ${block.start} - ${block.end} slot ${slotIndex + 1} assigned to ${finalEmployee.name} conflicts with schedule rules: ${allowed.reason}`,
          'override',
          block.day,
          date,
        );
      }
      if (hoursSoFar + blockHours > finalEmployee.maxAllowedWeeklyHours) {
        addScheduleAlert(
          reviewState.alerts,
          `${finalEmployee.name} would exceed the max weekly hours limit if assigned to ${DAY_FULL_LABELS[block.day]} ${block.start} - ${block.end} slot ${slotIndex + 1}.`,
          'override',
          block.day,
          date,
        );
      }

      const assignment = {
        id: baseAssignment?.id ?? uuid('assignment'),
        slotIndex,
        day: block.day,
        date,
        start: block.start,
        end: block.end,
        employeeId: finalEmployee.id,
        employeeName: finalEmployee.name,
        role: finalEmployee.role,
        hourlyWage: finalEmployee.hourlyWage,
        cost: blockHours * finalEmployee.hourlyWage,
        blockId: block.id,
        requiredStaff: block.requiredStaff,
      } satisfies ScheduleAssignment;

      reviewState.assignments.push(assignment);
      reviewState.employeeHours[finalEmployee.id] = hoursSoFar + blockHours;
      reviewState.employeeCost[finalEmployee.id] = (reviewState.employeeCost[finalEmployee.id] ?? 0) + assignment.cost;
      reviewState.dayCost[block.day] += assignment.cost;
      reviewState.daySummaries[block.day].totalAssigned += 1;
      reviewState.scheduledBlocks.push({
        employeeId: finalEmployee.id,
        day: block.day,
        start: block.start,
        end: block.end,
      });
    }

    const assignedCount = reviewState.assignments.filter((assignment) => assignment.blockId === block.id).length;
    if (assignedCount < block.requiredStaff) {
      addScheduleAlert(
        reviewState.alerts,
        `${DAY_FULL_LABELS[block.day]} ${block.start} - ${block.end} is understaffed by ${block.requiredStaff - assignedCount} employee(s).`,
        'understaffed',
        block.day,
        date,
      );
    }
  });

  state.employees.forEach((employee) => {
    if (!employee.active) return;
    const hours = reviewState.employeeHours[employee.id] ?? 0;
    if (hours < employee.minPreferredWeeklyHours) {
      addScheduleAlert(
        reviewState.alerts,
        `${employee.name} is scheduled for ${hours.toFixed(1)} hours, which is below the preferred minimum of ${employee.minPreferredWeeklyHours}.`,
        'hours',
      );
    }
  });

  const totalCost = Object.values(reviewState.employeeCost).reduce((sum, value) => sum + value, 0);

  return {
    assignments: reviewState.assignments.sort((a, b) => {
      const dayDiff = DAYS.indexOf(a.day) - DAYS.indexOf(b.day);
      if (dayDiff !== 0) return dayDiff;
      if (a.start !== b.start) return (parseTime(a.start) ?? 0) - (parseTime(b.start) ?? 0);
      return a.slotIndex - b.slotIndex;
    }),
    alerts: reviewState.alerts,
    employeeHours: reviewState.employeeHours,
    employeeCost: reviewState.employeeCost,
    dayCost: reviewState.dayCost,
    totalCost,
    daySummaries: reviewState.daySummaries,
  };
}

export function reviewScheduleRange(range: GeneratedScheduleRange, state: AppState, overrides: ScheduleOverrideMap): GeneratedScheduleRange {
  const weeks = range.weeks.map((week) => ({
    ...week,
    schedule: applyScheduleOverrides(week.schedule, state, overrides, week.weekStart),
  }));

  const alerts: ScheduleAlert[] = [];
  const employeeHours: Record<string, number> = {};
  const employeeCost: Record<string, number> = {};
  let totalCost = 0;

  weeks.forEach((week) => {
    alerts.push(...week.schedule.alerts);
    totalCost += week.schedule.totalCost;

    Object.entries(week.schedule.employeeHours).forEach(([employeeId, hours]) => {
      employeeHours[employeeId] = (employeeHours[employeeId] ?? 0) + hours;
    });

    Object.entries(week.schedule.employeeCost).forEach(([employeeId, cost]) => {
      employeeCost[employeeId] = (employeeCost[employeeId] ?? 0) + cost;
    });
  });

  return {
    weeks,
    alerts,
    employeeHours,
    employeeCost,
    totalCost,
  };
}
