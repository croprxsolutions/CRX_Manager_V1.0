import type { DeliveryIssueType } from '../types';

/** The issue types complete_delivery accepts (p_issue_type), with their labels; also used to show a saved issue. */
export const ISSUE_TYPE_LABELS: Record<DeliveryIssueType, string> = {
  none: 'None',
  customer_not_home: 'Customer Not Home',
  gate_locked: 'Gate Locked',
  road_blocked: 'Road Blocked',
  wrong_address: 'Wrong Address',
  refused: 'Refused',
  weather: 'Weather',
  other: 'Other',
};
