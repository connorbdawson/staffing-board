import type { AppState, DayKey, EmployeeAvailability } from './staffing';
import { DAYS, uuid } from './staffing';

const weeklyAvailability = (day: DayKey, start: string, end: string) => ({ day, ranges: [{ start, end }] });
const weeklyUnavailability = (day: DayKey, start: string, end: string) => ({ day, ranges: [{ start, end }] });

function makeAvailability(): EmployeeAvailability {
  return {
    weeklyAvailability: [],
    weeklyUnavailability: [],
    exceptions: [],
  };
}

export function createSeedState(): AppState {
  const employees = [
    {
      id: uuid('emp'),
      name: 'Ava Brooks',
      minPreferredWeeklyHours: 18,
      maxAllowedWeeklyHours: 32,
      priorityLevel: 5,
      active: true,
      notes: 'Strong opener. Prefers mornings.',
    },
    {
      id: uuid('emp'),
      name: 'Jordan Patel',
      minPreferredWeeklyHours: 28,
      maxAllowedWeeklyHours: 40,
      priorityLevel: 5,
      active: true,
      notes: 'Best for busy lunch blocks.',
    },
    {
      id: uuid('emp'),
      name: 'Mia Chen',
      minPreferredWeeklyHours: 12,
      maxAllowedWeeklyHours: 24,
      priorityLevel: 4,
      active: true,
      notes: 'Prefers afternoon prep work.',
    },
    {
      id: uuid('emp'),
      name: 'Noah Garcia',
      minPreferredWeeklyHours: 16,
      maxAllowedWeeklyHours: 28,
      priorityLevel: 3,
      active: true,
      notes: 'Works best on short shifts.',
    },
    {
      id: uuid('emp'),
      name: 'Sofia Nguyen',
      minPreferredWeeklyHours: 10,
      maxAllowedWeeklyHours: 20,
      priorityLevel: 4,
      active: true,
      notes: 'Available most evenings.',
    },
    {
      id: uuid('emp'),
      name: 'Ethan Kim',
      minPreferredWeeklyHours: 20,
      maxAllowedWeeklyHours: 35,
      priorityLevel: 4,
      active: true,
      notes: 'Reliable for closing coverage.',
    },
    {
      id: uuid('emp'),
      name: 'Chloe Rivera',
      minPreferredWeeklyHours: 8,
      maxAllowedWeeklyHours: 16,
      priorityLevel: 2,
      active: true,
      notes: 'Part-time helper for weekends.',
    },
    {
      id: uuid('emp'),
      name: 'Ben Walker',
      minPreferredWeeklyHours: 14,
      maxAllowedWeeklyHours: 30,
      priorityLevel: 3,
      active: true,
      notes: 'Use when coverage is tight.',
    },
    {
      id: uuid('emp'),
      name: 'Priya Shah',
      minPreferredWeeklyHours: 24,
      maxAllowedWeeklyHours: 40,
      priorityLevel: 5,
      active: true,
      notes: 'Preferred for high-volume periods.',
    },
    {
      id: uuid('emp'),
      name: 'Logan Price',
      minPreferredWeeklyHours: 6,
      maxAllowedWeeklyHours: 12,
      priorityLevel: 1,
      active: true,
      notes: 'Backup help on weekends.',
    },
  ];

  const availability: Record<string, EmployeeAvailability> = Object.fromEntries(
    employees.map((employee, index) => {
      const data = makeAvailability();
      if (index % 2 === 0) {
        data.weeklyAvailability.push(weeklyAvailability('mon', '08:00', '17:00'));
        data.weeklyAvailability.push(weeklyAvailability('tue', '08:00', '17:00'));
        data.weeklyAvailability.push(weeklyAvailability('wed', '08:00', '17:00'));
        data.weeklyAvailability.push(weeklyAvailability('thu', '08:00', '17:00'));
        data.weeklyAvailability.push(weeklyAvailability('fri', '08:00', '17:00'));
      } else {
        data.weeklyAvailability.push(weeklyAvailability('mon', '11:00', '20:00'));
        data.weeklyAvailability.push(weeklyAvailability('tue', '11:00', '20:00'));
        data.weeklyAvailability.push(weeklyAvailability('wed', '11:00', '20:00'));
        data.weeklyAvailability.push(weeklyAvailability('thu', '11:00', '20:00'));
        data.weeklyAvailability.push(weeklyAvailability('fri', '11:00', '20:00'));
      }
      if (index < 5) {
        data.weeklyAvailability.push(weeklyAvailability('sat', '09:00', '14:00'));
      }
      if (index === 1) {
        data.weeklyUnavailability.push(weeklyUnavailability('fri', '12:00', '15:00'));
        data.exceptions.push({
          id: uuid('exc'),
          date: new Date().toISOString().slice(0, 10),
          type: 'unavailable',
          start: '09:00',
          end: '13:00',
          notes: 'Doctor appointment',
        });
      }
      return [employee.id, data];
    }),
  );

  const businessHours = [
    { day: 'mon', ranges: [{ start: '08:00', end: '20:00' }] },
    { day: 'tue', ranges: [{ start: '08:00', end: '20:00' }] },
    { day: 'wed', ranges: [{ start: '08:00', end: '20:00' }] },
    { day: 'thu', ranges: [{ start: '08:00', end: '20:00' }] },
    { day: 'fri', ranges: [{ start: '08:00', end: '21:00' }] },
    { day: 'sat', ranges: [{ start: '09:00', end: '16:00' }] },
    { day: 'sun', ranges: [] },
  ] as AppState['businessHours'];

  const shiftTemplates = [
    { id: uuid('tpl'), label: 'Open', start: '08:00', end: '12:00', requiredStaff: 2, notes: 'Opening coverage' },
    { id: uuid('tpl'), label: 'Lunch', start: '10:00', end: '14:00', requiredStaff: 3, notes: 'Midday coverage' },
    { id: uuid('tpl'), label: 'Close', start: '14:00', end: '18:00', requiredStaff: 2, notes: 'Closing coverage' },
    { id: uuid('tpl'), label: 'Full day', start: '08:00', end: '17:00', requiredStaff: 1, notes: 'Single staff shift' },
  ] as AppState['shiftTemplates'];

  const staffingRequirements = [
    { id: uuid('req'), day: 'mon', start: '08:00', end: '10:00', requiredStaff: 2, role: 'Open', notes: 'Opening rush' },
    { id: uuid('req'), day: 'mon', start: '10:00', end: '14:00', requiredStaff: 3, role: 'Core', notes: 'Lunch prep and service' },
    { id: uuid('req'), day: 'mon', start: '14:00', end: '18:00', requiredStaff: 2, role: 'Support', notes: 'Afternoon coverage' },
    { id: uuid('req'), day: 'tue', start: '08:00', end: '10:00', requiredStaff: 2, role: 'Open', notes: 'Opening rush' },
    { id: uuid('req'), day: 'tue', start: '10:00', end: '14:00', requiredStaff: 3, role: 'Core', notes: 'Lunch prep and service' },
    { id: uuid('req'), day: 'tue', start: '14:00', end: '18:00', requiredStaff: 2, role: 'Support', notes: 'Afternoon coverage' },
    { id: uuid('req'), day: 'wed', start: '08:00', end: '10:00', requiredStaff: 2, role: 'Open', notes: 'Opening rush' },
    { id: uuid('req'), day: 'wed', start: '10:00', end: '14:00', requiredStaff: 3, role: 'Core', notes: 'Lunch prep and service' },
    { id: uuid('req'), day: 'wed', start: '14:00', end: '18:00', requiredStaff: 2, role: 'Support', notes: 'Afternoon coverage' },
    { id: uuid('req'), day: 'thu', start: '08:00', end: '10:00', requiredStaff: 2, role: 'Open', notes: 'Opening rush' },
    { id: uuid('req'), day: 'thu', start: '10:00', end: '14:00', requiredStaff: 3, role: 'Core', notes: 'Lunch prep and service' },
    { id: uuid('req'), day: 'thu', start: '14:00', end: '18:00', requiredStaff: 2, role: 'Support', notes: 'Afternoon coverage' },
    { id: uuid('req'), day: 'fri', start: '08:00', end: '10:00', requiredStaff: 2, role: 'Open', notes: 'Opening rush' },
    { id: uuid('req'), day: 'fri', start: '10:00', end: '15:00', requiredStaff: 4, role: 'Core', notes: 'Busy lunch period' },
    { id: uuid('req'), day: 'fri', start: '15:00', end: '20:00', requiredStaff: 3, role: 'Support', notes: 'Closing prep' },
    { id: uuid('req'), day: 'sat', start: '09:00', end: '12:00', requiredStaff: 3, role: 'Core', notes: 'Weekend open' },
    { id: uuid('req'), day: 'sat', start: '12:00', end: '16:00', requiredStaff: 2, role: 'Support', notes: 'Weekend support' },
  ] as AppState['staffingRequirements'];

  return {
    employees,
    availability,
    businessHours,
    shiftTemplates,
    staffingRequirements,
    staffingPatternTemplates: [],
    scheduleOverrides: {},
    schedulePublishedAt: null,
    updatedAt: new Date().toISOString(),
  };
}

export function createEmptyAvailability() {
  return {
    weeklyAvailability: [],
    weeklyUnavailability: [],
    exceptions: [],
  } satisfies EmployeeAvailability;
}

export function createEmptyState(): AppState {
  return {
    employees: [],
    availability: {},
    businessHours: DAYS.map((day) => ({ day, ranges: [] })),
    shiftTemplates: [],
    staffingRequirements: [],
    staffingPatternTemplates: [],
    scheduleOverrides: {},
    schedulePublishedAt: null,
    updatedAt: new Date().toISOString(),
  };
}
