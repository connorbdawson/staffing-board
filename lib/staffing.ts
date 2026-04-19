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
  updatedAt: string;
};

export type ScheduleAssignment = {
  id: string;
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
  kind: 'understaffed' | 'availability' | 'validation' | 'hours';
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

function findRuleForDay(rules: WeeklyRule[], day: DayKey) {
  return rules.find((rule) => rule.day === day);
}

function blockWithinRules(block: { day: DayKey; start: string; end: string }, rules: WeeklyRule[]) {
  const rule = findRuleForDay(rules, block.day);
  if (!rule) return false;
  return rule.ranges.some((range) => containsRange(range.start, range.end, block.start, block.end));
}

function blockIntersectsRules(block: { day: DayKey; start: string; end: string }, rules: WeeklyRule[]) {
  const rule = findRuleForDay(rules, block.day);
  if (!rule) return false;
  return rule.ranges.some((range) => overlaps(range.start, range.end, block.start, block.end));
}

export function canWorkBlock(
  employeeId: string,
  block: { day: DayKey; start: string; end: string; date: string },
  state: AppState,
  assignedBlocks: Array<{ employeeId: string; day: DayKey; start: string; end: string }>,
) {
  const employeeAvailability = state.availability[employeeId];
  const blockMinutes = durationHours(block.start, block.end);
  if (blockMinutes <= 0) return { allowed: false, reason: 'Invalid block time.' };

  const exception = employeeAvailability.exceptions.find((entry) => entry.date === block.date && overlaps(entry.start, entry.end, block.start, block.end));
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

  const sortedRequirements = [...state.staffingRequirements].sort((a, b) => {
    const dayDiff = DAYS.indexOf(a.day) - DAYS.indexOf(b.day);
    if (dayDiff !== 0) return dayDiff;
    return parseTime(a.start)! - parseTime(b.start)!;
  });

  for (const requirement of sortedRequirements) {
    const date = isoDateForWeekDay(weekStart, requirement.day);
    const blockHours = durationHours(requirement.start, requirement.end);
    daySummaries[requirement.day].totalRequired += requirement.requiredStaff;
    daySummaries[requirement.day].blocks.push(requirement);

    if (!blockWithinRules(requirement, state.businessHours)) {
      alerts.push({
        id: uuid('alert'),
        kind: 'validation',
        day: requirement.day,
        date,
        message: `${dayFullLabel(requirement.day)} ${requirement.start} - ${requirement.end} sits outside business hours.`,
      });
    }

    let slotsRemaining = requirement.requiredStaff;
    const availableEmployees = state.employees
      .filter((employee) => employee.active)
      .map((employee) => ({
        employee,
        score: 0,
      }));

    while (slotsRemaining > 0) {
      const scoredCandidates = availableEmployees
        .map(({ employee }) => {
          const hoursSoFar = employeeHours[employee.id] ?? 0;
          const check = canWorkBlock(
            employee.id,
            { day: requirement.day, start: requirement.start, end: requirement.end, date },
            state,
            scheduledBlocks,
          );
          if (!check.allowed) return null;

          // Heuristic: prioritize high-priority employees, then fill preferred-hour gaps,
          // then gently favor people with fewer assigned hours and lower wage.
          const minGap = Math.max(0, employee.minPreferredWeeklyHours - hoursSoFar);
          const priorityBoost = employee.priorityLevel * 100;
          const deficitBoost = minGap > 0 ? 1000 + minGap * 60 : 0;
          const loadPenalty = hoursSoFar * 15;
          const wagePenalty = employee.hourlyWage * 0.5;

          return {
            employee,
            score: priorityBoost + deficitBoost - loadPenalty - wagePenalty,
          };
        })
        .filter((candidate): candidate is { employee: (typeof state.employees)[number]; score: number } => Boolean(candidate))
        .sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          if (b.employee.priorityLevel !== a.employee.priorityLevel) {
            return b.employee.priorityLevel - a.employee.priorityLevel;
          }
          return a.employee.hourlyWage - b.employee.hourlyWage;
        });

      const pick = scoredCandidates[0];
      if (!pick) {
        alerts.push({
          id: uuid('alert'),
          kind: 'understaffed',
          day: requirement.day,
          date,
          message: `${dayFullLabel(requirement.day)} ${requirement.start} - ${requirement.end} is understaffed by ${slotsRemaining} employee(s).`,
        });
        break;
      }

      const hours = employeeHours[pick.employee.id] ?? 0;
      if (hours + blockHours > pick.employee.maxAllowedWeeklyHours) {
        const index = availableEmployees.findIndex(({ employee }) => employee.id === pick.employee.id);
        if (index >= 0) {
          availableEmployees.splice(index, 1);
        }
        continue;
      }

      const cost = blockHours * pick.employee.hourlyWage;
      employeeHours[pick.employee.id] = hours + blockHours;
      employeeCost[pick.employee.id] = (employeeCost[pick.employee.id] ?? 0) + cost;
      dayCost[requirement.day] += cost;
      daySummaries[requirement.day].totalAssigned += 1;

      assignments.push({
        id: uuid('assignment'),
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

      const index = availableEmployees.findIndex(({ employee }) => employee.id === pick.employee.id);
      if (index >= 0) {
        availableEmployees.splice(index, 1);
      }

      slotsRemaining -= 1;
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
