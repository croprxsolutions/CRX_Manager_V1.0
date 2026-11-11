import { useEffect, useState, useCallback, useRef, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Save, UserPlus, Pencil, Shield, Users, KeyRound, Receipt, Sprout, Building2 } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import Badge from '../components/ui/Badge';
import Modal from '../components/ui/Modal';
import ConfirmModal from '../components/ui/ConfirmModal';
import UnsavedChangesModal from '../components/ui/UnsavedChangesModal';
import SectionJumpBar from '../components/ui/SectionJumpBar';
import Skeleton from '../components/ui/Skeleton';
import EmptyState, { LoadFailedState } from '../components/ui/EmptyState';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { logActivity } from '../lib/activityLogger';
import { supabase, checkMutationResult, sanitizeError, assertRpcResult } from '../lib/db';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { getPagesForRole, getCategories } from '../lib/pagePermissions';
import { Sentry } from '../lib/sentry';
import {
  DEFAULT_FUEL_SURCHARGE,
  parseFuelSurchargeConfig,
  serializeFuelSurchargeConfig,
  fuelSurchargeIsActive,
  validateFuelSurchargeConfig,
  fuelSurchargeRateUnit,
  type FuelSurchargeConfig,
  type FuelSurchargeBasis,
} from '../lib/fuelSurcharge';
import {
  DEFAULT_CUSTOM_CONFIG,
  parseCustomConfig,
  serializeCustomConfig,
  type ApplicatorSheetCustomConfig,
} from '../lib/applicatorSheetData';
import {
  DEFAULT_PRE_NOTIFICATION_TEMPLATE,
  parsePreNotificationTemplate,
  type PreNotificationTemplate,
} from '../lib/preNotification';
import {
  DEFAULT_POST_NOTIFICATION_TEMPLATE,
  parsePostNotificationTemplate,
  type PostNotificationTemplate,
} from '../lib/postNotification';
import {
  AUTO_DRAFT_SETTING_KEY,
  DEFAULT_AUTO_DRAFT_ENABLED,
  parseAutoDraftEnabled,
  serializeAutoDraftEnabled,
} from '../lib/autoDraftSetting';
import {
  LABEL_RATE_GUARDRAIL_MODE_KEY,
  DEFAULT_GUARDRAIL_MODE,
  parseGuardrailMode,
  serializeGuardrailMode,
  type GuardrailMode,
} from '../lib/labelGuardrailSetting';
import type { Profile, AppSetting, UserRole } from '../types';

const ROLE_LABELS: Record<UserRole, string> = {
  admin: 'Admin',
  sales_rep: 'Sales rep',
  driver: 'Driver',
  applicator: 'Applicator',
};

const FIELD_CLASS =
  'h-9 rounded-lg border border-gray-300 bg-white px-3 text-sm text-nav-dark placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green disabled:bg-gray-50 disabled:text-gray-500';
const CHECK_CLASS = 'w-4 h-4 rounded border-gray-300 text-crx-green focus:ring-crx-green/20';
const TEXTAREA_CLASS =
  'w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-nav-dark placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green resize-y';

// --- Style D building blocks (first use; move to components/ui the second time they are needed) ---

function SettingsSection({ id, icon, title, action, children }: {
  id: string;
  icon: ReactNode;
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card id={id} padding={false} className="scroll-mt-32 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 bg-cream-dark px-4 py-3">
        <div className="flex items-center gap-3">
          <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-crx-green text-white">
            {icon}
          </span>
          <h2 className="font-heading text-2xl font-bold leading-none text-nav-dark">{title}</h2>
        </div>
        {action}
      </div>
      {children}
    </Card>
  );
}

function SaveButton({ dirty, saving, onClick, label }: {
  dirty: boolean;
  saving: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <Button
      size="sm"
      variant={dirty ? 'primary' : 'secondary'}
      icon={<Save className="w-4 h-4" />}
      onClick={onClick}
      disabled={!dirty}
      loading={saving}
    >
      {label}
    </Button>
  );
}

function UnsavedChip({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <span className="ml-2 inline-block rounded-full bg-amber-100 px-2 py-0.5 align-middle font-sans text-xs font-semibold text-amber-800">
      Unsaved
    </span>
  );
}

function SubPart({ title, help, dirty, saveButton, children }: {
  title: string;
  help?: ReactNode;
  dirty: boolean;
  saveButton: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="border-t border-gray-200">
      <div className="flex flex-wrap items-start justify-between gap-2 px-4 pt-3 pb-1">
        <div className="min-w-0 flex-1 basis-64">
          <h3 className="font-heading text-lg font-semibold text-nav-dark">
            {title}
            <UnsavedChip show={dirty} />
          </h3>
          {help && <p className="mt-0.5 text-[13px] text-secondary">{help}</p>}
        </div>
        {saveButton}
      </div>
      {children}
    </section>
  );
}

/** Label on the left (about 220px), field beside it; the label stacks above the field on phones. */
function Row({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  const labelClass = 'text-sm font-semibold text-nav-dark sm:w-[220px] sm:shrink-0';
  return (
    <div className="flex flex-col gap-1.5 border-b border-gray-100 px-4 py-2 last:border-b-0 sm:flex-row sm:items-center sm:gap-4">
      {htmlFor ? (
        <label htmlFor={htmlFor} className={labelClass}>{label}</label>
      ) : (
        <span className={labelClass}>{label}</span>
      )}
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1.5 text-sm">{children}</div>
    </div>
  );
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
}

function pageAccessLabel(user: Profile) {
  if (user.role === 'admin') return 'Full access';
  const pages = getPagesForRole(user.role);
  const allowed = pages.filter((p) => !(user.denied_pages || []).includes(p.key)).length;
  return allowed === pages.length ? 'All pages' : `${allowed} of ${pages.length} pages`;
}

// --- Saved-value tracking: each sub-part's Save stays off until one of its settings differs from what was loaded or last saved ---

interface SettingsForm {
  companyName: string;
  companyPhone: string;
  companyEmail: string;
  companyAddress: string;
  defaultValidDays: string;
  arReminderDays: string;
  defaultTier: string;
  salesTaxRate: string;
  fuelSurcharge: FuelSurchargeConfig;
  autoDraftEnabled: boolean;
  guardrailMode: GuardrailMode;
  sheetConfig: ApplicatorSheetCustomConfig;
  preNoticeTemplate: PreNotificationTemplate;
  postNoticeTemplate: PostNotificationTemplate;
}

/** Each setting exactly as its Save writes it to app_settings. */
function toSettingValues(f: SettingsForm): Record<string, string> {
  return {
    company_name: f.companyName,
    company_phone: f.companyPhone,
    company_email: f.companyEmail,
    company_address: f.companyAddress,
    default_quote_valid_days: f.defaultValidDays,
    ar_reminder_days: f.arReminderDays,
    default_tier: f.defaultTier,
    sales_tax_rate: f.salesTaxRate,
    fuel_surcharge: serializeFuelSurchargeConfig(f.fuelSurcharge),
    [AUTO_DRAFT_SETTING_KEY]: serializeAutoDraftEnabled(f.autoDraftEnabled),
    [LABEL_RATE_GUARDRAIL_MODE_KEY]: serializeGuardrailMode(f.guardrailMode),
    applicator_sheet_custom: serializeCustomConfig(f.sheetConfig),
    pre_application_notice_template: JSON.stringify({ subject: f.preNoticeTemplate.subject, body: f.preNoticeTemplate.body }),
    post_application_notice_template: JSON.stringify({ subject: f.postNoticeTemplate.subject, body: f.postNoticeTemplate.body }),
  };
}

const GROUP_KEYS = {
  company: ['company_name', 'company_phone', 'company_email', 'company_address'],
  fuel: ['fuel_surcharge'],
  autoDraft: [AUTO_DRAFT_SETTING_KEY],
  defaults: ['default_quote_valid_days', 'ar_reminder_days', 'default_tier'],
  salesTax: ['sales_tax_rate'],
  guardrail: [LABEL_RATE_GUARDRAIL_MODE_KEY],
  sheet: ['applicator_sheet_custom'],
  notices: ['pre_application_notice_template', 'post_application_notice_template'],
} as const;
type SettingsGroup = keyof typeof GROUP_KEYS;

// --- Permissions Panel ---

function UserPermissionsPanel({
  role,
  deniedPages,
  onChange,
}: {
  role: UserRole;
  deniedPages: string[];
  onChange: (pages: string[]) => void;
}) {
  const rolePages = getPagesForRole(role);
  const categories = getCategories(rolePages);

  if (role === 'admin') return null;
  if (rolePages.length === 0) return null;

  const allowedCount = rolePages.length - deniedPages.length;

  const togglePage = (key: string) => {
    if (deniedPages.includes(key)) {
      onChange(deniedPages.filter((k) => k !== key));
    } else {
      onChange([...deniedPages, key]);
    }
  };

  const enableAll = () => onChange([]);
  const disableAll = () => onChange(rolePages.map((p) => p.key));

  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 bg-gray-50 border-b border-gray-200">
        <div className="flex items-center gap-2">
          <Shield className="w-4 h-4 text-crx-green" />
          <span className="text-sm font-medium text-nav-dark">
            Page Access ({allowedCount}/{rolePages.length})
          </span>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={enableAll}
            className="text-xs text-crx-green hover:underline"
          >
            Enable All
          </button>
          <span className="text-gray-300">|</span>
          <button
            type="button"
            onClick={disableAll}
            className="text-xs text-red-600 hover:underline"
          >
            Disable All
          </button>
        </div>
      </div>
      <div className="max-h-64 overflow-y-auto px-3 py-2 space-y-3">
        {categories.map((cat) => {
          const catPages = rolePages.filter((p) => p.category === cat);
          return (
            <div key={cat}>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 mb-1">
                {cat}
              </p>
              <div className="space-y-1">
                {catPages.map((page) => {
                  const allowed = !deniedPages.includes(page.key);
                  return (
                    <label
                      key={page.key}
                      className="flex items-center gap-2 cursor-pointer py-0.5"
                    >
                      <input
                        type="checkbox"
                        checked={allowed}
                        onChange={() => togglePage(page.key)}
                        className="w-3.5 h-3.5 rounded border-gray-300 text-crx-green focus:ring-crx-green/20"
                      />
                      <span className={`text-sm ${allowed ? 'text-nav-dark' : 'text-gray-500 line-through'}`}>
                        {page.label}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// --- Settings Page ---

export default function SettingsPage() {
  const { role, profile } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const adminUpdateIdem = useIdempotencyKey('admin_update_profile', profile?.id || '');
  const newUserRoleIdem = useIdempotencyKey('admin_update_profile_new_user', profile?.id || '');

  const [companyName, setCompanyName] = useState('');
  const [companyPhone, setCompanyPhone] = useState('');
  const [companyEmail, setCompanyEmail] = useState('');
  const [companyAddress, setCompanyAddress] = useState('');
  const [defaultValidDays, setDefaultValidDays] = useState('30');
  const [arReminderDays, setArReminderDays] = useState('30');
  const [defaultTier, setDefaultTier] = useState('1');
  const [salesTaxRate, setSalesTaxRate] = useState('6.25');
  const [savingSalesTax, setSavingSalesTax] = useState(false);
  // #32: Fuel Surcharge — OFF by default, rate blank. The owner sets the rule.
  const [fuelSurcharge, setFuelSurcharge] = useState<FuelSurchargeConfig>(DEFAULT_FUEL_SURCHARGE);
  const [savingFuel, setSavingFuel] = useState(false);
  // §4: Auto-draft invoice on job completion — OFF by default (never auto-posts).
  const [autoDraftEnabled, setAutoDraftEnabled] = useState<boolean>(DEFAULT_AUTO_DRAFT_ENABLED);
  const [savingAutoDraft, setSavingAutoDraft] = useState(false);
  // §5: Label-rate guardrail mode — WARN by default (never blocks a save).
  const [guardrailMode, setGuardrailMode] = useState<GuardrailMode>(DEFAULT_GUARDRAIL_MODE);
  const [savingGuardrail, setSavingGuardrail] = useState(false);
  // #9: Custom applicator field-sheet layout (LAYOUT ONLY — header/logo/footer +
  // optional column toggles). Blank by default => standard CRX header.
  const [sheetConfig, setSheetConfig] = useState<ApplicatorSheetCustomConfig>(DEFAULT_CUSTOM_CONFIG);
  const [savingSheet, setSavingSheet] = useState(false);
  // Field-app parity #40/#41: editable pre- and post-application notice templates (subject + body).
  const [preNoticeTemplate, setPreNoticeTemplate] = useState<PreNotificationTemplate>(DEFAULT_PRE_NOTIFICATION_TEMPLATE);
  const [postNoticeTemplate, setPostNoticeTemplate] = useState<PostNotificationTemplate>(DEFAULT_POST_NOTIFICATION_TEMPLATE);
  const [savingNotices, setSavingNotices] = useState(false);
  const [users, setUsers] = useState<Profile[]>([]);
  const [savingCompany, setSavingCompany] = useState(false);
  const [savingDefaults, setSavingDefaults] = useState(false);
  const [userModalOpen, setUserModalOpen] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [newName, setNewName] = useState('');
  const [newRole, setNewRole] = useState<UserRole>('sales_rep');
  const [newPassword, setNewPassword] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [creatingUser, setCreatingUser] = useState(false);

  // Edit user state
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<Profile | null>(null);
  const [editRole, setEditRole] = useState<UserRole>('sales_rep');
  const [editName, setEditName] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [editIsActive, setEditIsActive] = useState(true);
  const [editDeniedPages, setEditDeniedPages] = useState<string[]>([]);
  const [savingUser, setSavingUser] = useState(false);
  const [editConfirmOpen, setEditConfirmOpen] = useState(false);
  const [passwordModalOpen, setPasswordModalOpen] = useState(false);
  const [passwordTarget, setPasswordTarget] = useState<Profile | null>(null);
  const [adminSetPassword, setAdminSetPassword] = useState('');
  const [adminConfirmPassword, setAdminConfirmPassword] = useState('');
  const [settingPassword, setSettingPassword] = useState(false);
  const [pageLoading, setPageLoading] = useState(true);
  const [usersLoadError, setUsersLoadError] = useState(false);
  // Only the newest users read may change the list or its error state (Try again can overlap a slower read).
  const usersLoadSeqRef = useRef(0);
  // The settings read failed: the forms would show blank defaults, and saving them would overwrite the
  // real values, so they are replaced by the failed state and every save is refused (To-Do 10.5).
  const [settingsLoadError, setSettingsLoadError] = useState(false);
  // True once a settings read has succeeded: until then the forms hold defaults, not saved values.
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const settingsLoadSeqRef = useRef(0);
  // What each setting held when it was loaded or last saved; null until a read succeeds.
  const [savedValues, setSavedValues] = useState<Record<string, string> | null>(null);

  const values = toSettingValues({
    companyName, companyPhone, companyEmail, companyAddress, defaultValidDays, arReminderDays, defaultTier, salesTaxRate,
    fuelSurcharge, autoDraftEnabled, guardrailMode, sheetConfig, preNoticeTemplate, postNoticeTemplate,
  });
  const changedKeys = (group: SettingsGroup) =>
    savedValues === null ? [] : GROUP_KEYS[group].filter((key) => values[key] !== savedValues[key]);
  const isDirty = (group: SettingsGroup) => changedKeys(group).length > 0;
  const markSaved = (keys: readonly string[], saved: Record<string, string> = values) =>
    setSavedValues((prev) => prev && { ...prev, ...Object.fromEntries(keys.map((key) => [key, saved[key]])) });
  const anyDirty = !settingsLoadError && (Object.keys(GROUP_KEYS) as SettingsGroup[]).some(isDirty);
  const blocker = useUnsavedChanges(anyDirty);

  const fetchSettings = async () => {
    const seq = ++settingsLoadSeqRef.current;
    const { data, error } = await supabase.from('app_settings').select('*');
    if (seq !== settingsLoadSeqRef.current) return;
    // No list is not a load: the forms would show defaults that a save writes over the real values.
    if (error || !Array.isArray(data)) {
      toast('error', 'Failed to load settings');
      setSettingsLoadError(true);
      return;
    }
    const settings = (data || []) as AppSetting[];
    const map: Record<string, string> = {};
    settings.forEach((s) => { map[s.setting_key] = s.setting_value; });
    const loaded: SettingsForm = {
      companyName: map['company_name'] || '',
      companyPhone: map['company_phone'] || '',
      companyEmail: map['company_email'] || '',
      companyAddress: map['company_address'] || '',
      defaultValidDays: map['default_quote_valid_days'] || '30',
      arReminderDays: map['ar_reminder_days'] || '30',
      defaultTier: map['default_tier'] || '1',
      salesTaxRate: map['sales_tax_rate'] || '6.25',
      // #32: blank/absent => the inert OFF default (never invents a rate).
      fuelSurcharge: parseFuelSurchargeConfig(map['fuel_surcharge']),
      // §4: blank/absent/anything-but-'true' => OFF (the safe default).
      autoDraftEnabled: parseAutoDraftEnabled(map[AUTO_DRAFT_SETTING_KEY]),
      // §5: blank/absent/anything-but-'block' => WARN (the safe default; never blocks).
      guardrailMode: parseGuardrailMode(map[LABEL_RATE_GUARDRAIL_MODE_KEY]),
      // #9: blank/absent => standard CRX header + all optional columns shown.
      sheetConfig: parseCustomConfig(map['applicator_sheet_custom']),
      // #40/#41: blank/absent => the seeded default notice wording.
      preNoticeTemplate: parsePreNotificationTemplate(map['pre_application_notice_template']),
      postNoticeTemplate: parsePostNotificationTemplate(map['post_application_notice_template']),
    };
    setCompanyName(loaded.companyName);
    setCompanyPhone(loaded.companyPhone);
    setCompanyEmail(loaded.companyEmail);
    setCompanyAddress(loaded.companyAddress);
    setDefaultValidDays(loaded.defaultValidDays);
    setArReminderDays(loaded.arReminderDays);
    setDefaultTier(loaded.defaultTier);
    setSalesTaxRate(loaded.salesTaxRate);
    setFuelSurcharge(loaded.fuelSurcharge);
    setAutoDraftEnabled(loaded.autoDraftEnabled);
    setGuardrailMode(loaded.guardrailMode);
    setSheetConfig(loaded.sheetConfig);
    setPreNoticeTemplate(loaded.preNoticeTemplate);
    setPostNoticeTemplate(loaded.postNoticeTemplate);
    setSavedValues(toSettingValues(loaded));
    setSettingsLoadError(false);
    setSettingsLoaded(true);
  };

  const fetchUsers = async () => {
    const seq = ++usersLoadSeqRef.current;
    // Codex P2 (PR #59, 2026-05-16): exclude entity_recipient service profiles
    // (CMCTW LLC, Crop Rx Solutions) from the user-management table — they
    // can't log in and showing them in the Edit/Set-Password UI risks an
    // admin accidentally setting a real password and defeating the
    // "can never log in" guarantee from migration 20260516090000.
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .neq('role', 'entity_recipient')
      .order('full_name');
    if (seq !== usersLoadSeqRef.current) return;
    if (error) {
      toast('error', 'Failed to load users');
      setUsersLoadError(true);
      return;
    }
    setUsersLoadError(false);
    setUsers((data || []) as Profile[]);
  };

  useEffect(() => {
    if (role !== 'admin') {
      navigate('/');
      return;
    }
    Promise.all([fetchSettings(), fetchUsers()]).finally(() => setPageLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role, navigate]);

  const saveSetting = async (key: string, value: string) => {
    if (settingsLoadError || !settingsLoaded) throw new Error('Settings did not load. Press Try again before saving.');
    const result = await supabase
      .from('app_settings')
      .upsert(
        { setting_key: key, setting_value: value, updated_at: new Date().toISOString() },
        { onConflict: 'setting_key' }
      )
      .select();
    checkMutationResult(result, `Save setting: ${key}`);
  };

  const saveCompanyInfo = async () => {
    setSavingCompany(true);
    try {
      await Promise.all([
        saveSetting('company_name', companyName),
        saveSetting('company_phone', companyPhone),
        saveSetting('company_email', companyEmail),
        saveSetting('company_address', companyAddress),
      ]);
      markSaved(GROUP_KEYS.company);
      toast('success', 'Company info saved');
      if (profile) logActivity({ event: 'settings_updated', description: 'Company info updated', performedBy: profile.id });
    } catch (err: unknown) {
      toast('error', sanitizeError(err));
    }
    setSavingCompany(false);
  };

  const saveDefaults = async () => {
    setSavingDefaults(true);
    // Clamp the AR reminder threshold to exactly what get_ar_reminder_candidates enforces
    // (1..3650 whole days) so the stored/shown value can never diverge from the cadence used.
    const nReminder = parseInt(arReminderDays, 10);
    const normalizedReminderDays = String(Number.isFinite(nReminder) ? Math.min(Math.max(nReminder, 1), 3650) : 30);
    setArReminderDays(normalizedReminderDays);
    try {
      await Promise.all([
        saveSetting('default_quote_valid_days', defaultValidDays),
        saveSetting('ar_reminder_days', normalizedReminderDays),
        saveSetting('default_tier', defaultTier),
      ]);
      markSaved(GROUP_KEYS.defaults, { ...values, ar_reminder_days: normalizedReminderDays });
      toast('success', 'Default settings saved');
      if (profile) logActivity({ event: 'settings_updated', description: 'Default settings updated', performedBy: profile.id });
    } catch (err: unknown) {
      toast('error', sanitizeError(err));
    }
    setSavingDefaults(false);
  };

  // The database accepts only a plain percentage (app_settings_sales_tax_rate_chk, migration 20261231120000).
  const saveSalesTax = async () => {
    const rate = salesTaxRate.trim();
    if (!/^[0-9]{1,2}(\.[0-9]{1,3})?$/.test(rate)) {
      toast('error', 'Enter the sales tax rate as a percentage from 0 to 99.999, for example 6.25.');
      return;
    }
    setSavingSalesTax(true);
    try {
      await saveSetting('sales_tax_rate', rate);
      setSalesTaxRate(rate);
      markSaved(GROUP_KEYS.salesTax, { ...values, sales_tax_rate: rate });
      toast('success', 'Sales tax rate saved');
      if (profile) logActivity({ event: 'settings_updated', description: `Sales tax rate set to ${rate}%`, performedBy: profile.id });
    } catch (err: unknown) {
      toast('error', sanitizeError(err));
    }
    setSavingSalesTax(false);
  };

  const saveFuelSurcharge = async () => {
    // #32: UI guard. OFF/blank are never errors; only an inconsistent ON config is.
    const err = validateFuelSurchargeConfig(fuelSurcharge);
    if (err) {
      toast('error', err);
      return;
    }
    setSavingFuel(true);
    try {
      await saveSetting('fuel_surcharge', serializeFuelSurchargeConfig(fuelSurcharge));
      markSaved(GROUP_KEYS.fuel);
      toast('success', 'Fuel surcharge settings saved');
      if (profile) {
        logActivity({
          event: 'settings_updated',
          description: `Fuel surcharge ${fuelSurcharge.enabled ? 'enabled' : 'disabled'} (basis: ${fuelSurcharge.basis || 'none'}, rate: ${fuelSurcharge.rate.trim() || 'blank'})`,
          performedBy: profile.id,
        });
      }
    } catch (errUnknown: unknown) {
      toast('error', sanitizeError(errUnknown));
    }
    setSavingFuel(false);
  };

  const saveAutoDraft = async () => {
    setSavingAutoDraft(true);
    try {
      await saveSetting(AUTO_DRAFT_SETTING_KEY, serializeAutoDraftEnabled(autoDraftEnabled));
      markSaved(GROUP_KEYS.autoDraft);
      toast('success', `Auto-invoice ${autoDraftEnabled ? 'enabled' : 'disabled'}`);
      if (profile) {
        logActivity({
          event: 'settings_updated',
          description: `Auto-draft invoice on job completion ${autoDraftEnabled ? 'enabled' : 'disabled'} (drafts only — never auto-posts)`,
          performedBy: profile.id,
        });
      }
    } catch (errUnknown: unknown) {
      toast('error', sanitizeError(errUnknown));
    }
    setSavingAutoDraft(false);
  };

  const saveGuardrailMode = async () => {
    setSavingGuardrail(true);
    try {
      await saveSetting(LABEL_RATE_GUARDRAIL_MODE_KEY, serializeGuardrailMode(guardrailMode));
      markSaved(GROUP_KEYS.guardrail);
      toast('success', `Label-rate guardrail set to ${guardrailMode === 'block' ? 'Block (admin override required)' : 'Warn'}`);
      if (profile) {
        logActivity({
          event: 'settings_updated',
          description: `Label-rate guardrail mode set to '${guardrailMode}' (warn never blocks a save; block requires an admin override with a logged reason)`,
          performedBy: profile.id,
        });
      }
    } catch (errUnknown: unknown) {
      toast('error', sanitizeError(errUnknown));
    }
    setSavingGuardrail(false);
  };

  const saveSheetConfig = async () => {
    // #9: layout only — there is nothing to validate (any combination is valid;
    // blank fields fall back to the standard CRX header).
    setSavingSheet(true);
    try {
      await saveSetting('applicator_sheet_custom', serializeCustomConfig(sheetConfig));
      markSaved(GROUP_KEYS.sheet);
      toast('success', 'Custom applicator sheet settings saved');
      if (profile) {
        logActivity({
          event: 'settings_updated',
          description: 'Custom applicator field-sheet layout updated',
          performedBy: profile.id,
        });
      }
    } catch (errUnknown: unknown) {
      toast('error', sanitizeError(errUnknown));
    }
    setSavingSheet(false);
  };

  // #40/#41: persist the changed notice templates. Subject + body must all be non-blank
  // (a blank template would email an empty notice).
  const saveNoticeTemplates = async () => {
    const changed = changedKeys('notices');
    // Only the templates being saved are checked, as when each had its own Save.
    if (changed.includes('pre_application_notice_template')
      && (!preNoticeTemplate.subject.trim() || !preNoticeTemplate.body.trim())) {
      toast('error', 'The pre-notification subject and message cannot be blank.');
      return;
    }
    if (changed.includes('post_application_notice_template')
      && (!postNoticeTemplate.subject.trim() || !postNoticeTemplate.body.trim())) {
      toast('error', 'The post-notification subject and message cannot be blank.');
      return;
    }
    setSavingNotices(true);
    // Each template saves on its own, so one that saved is marked and logged even if the other fails.
    const results = await Promise.allSettled(changed.map((key) => saveSetting(key, values[key])));
    const saved = changed.filter((_, i) => results[i].status === 'fulfilled');
    markSaved(saved);
    if (profile) {
      for (const key of saved) {
        logActivity({
          event: 'settings_updated',
          description: key === 'pre_application_notice_template'
            ? 'Pre-application notice template updated'
            : 'Post-application notice template updated',
          performedBy: profile.id,
        });
      }
    }
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) toast('error', sanitizeError(failed.reason));
    else toast('success', 'Customer notices saved');
    setSavingNotices(false);
  };

  const toggleSheetColumn = (key: keyof ApplicatorSheetCustomConfig['columns']) => {
    setSheetConfig((c) => ({ ...c, columns: { ...c.columns, [key]: !c.columns[key] } }));
  };

  const handleCreateUser = async () => {
    if (!newEmail.trim() || !newName.trim() || !newPassword.trim()) return;
    if (newPassword.length < 6) {
      toast('error', 'Password must be at least 6 characters');
      return;
    }
    setCreatingUser(true);
    try {
      const session = (await supabase.auth.getSession()).data.session;
      if (!session) {
        toast('error', 'You are not logged in. Please sign in again.');
        setCreatingUser(false);
        return;
      }

      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/create-user`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.access_token}`,
            'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
          },
          body: JSON.stringify({
            email: newEmail,
            password: newPassword,
            full_name: newName,
            role: newRole,
            phone: newPhone || null,
          }),
        }
      );

      const data = await response.json();
      const newUserId: string | null = response.ok && !data?.error ? data.user.id : null;
      if (!newUserId) {
        let message = data?.error || `Request failed (${response.status})`;
        if (/already (been )?registered|already exists/i.test(String(data?.error ?? ''))) {
          // An earlier click whose reply was lost can leave this email's login created but never
          // activated ('Pending user <id>', inactive, login banned). It is NOT adopted here: a
          // self-signup could have taken the email first and would own the password, so an admin
          // decides. Only say so, so the admin is not left with a bare "already registered".
          const { data: pending } = await supabase
            .from('profiles')
            .select('id, full_name, is_active')
            .eq('email', newEmail.trim().toLowerCase())
            .maybeSingle();
          if (pending && !pending.is_active && pending.full_name === `Pending user ${pending.id}`) {
            message = `${newEmail} already has a blocked, not-yet-activated login (${pending.full_name}). If you just created it, open it in the list, set the name and role, mark it active, and set its password; if you did not, leave it blocked.`;
          }
        }
        toast('error', message);
        if (message !== data?.error) fetchUsers();
      } else {
        // handle_new_user (migration 20261022023000) creates every new login as an inactive,
        // login-blocked driver named 'Pending user <id>', whatever the signup metadata says. The
        // create-user function now sets the chosen name and role and activates the user in the same
        // request (`activated: true`). Only when it did not (an older deployed function, or its
        // activation failed) is it done here, by this admin. The key is scoped to the new user so a
        // lost reply for one user never replays onto the next.
        let activationError: string | null = null;
        if (data?.activated !== true) {
          try {
            const { data: roleData, error: roleError } = await supabase.rpc('admin_update_profile', {
              target_user_id: newUserId,
              new_role: newRole,
              new_full_name: newName,
              new_phone: newPhone || undefined,
              new_is_active: true,
              p_idempotency_key: newUserRoleIdem.getKeyFor(newUserId),
            });
            if (roleError) {
              activationError = /duplicate key|uq_profiles_.*full_name/i.test(String((roleError as { message?: string })?.message ?? ''))
                ? `Another user is already named ${newName}. The new login (${newEmail}) exists but is blocked: open it, give it a different name and role, and mark it active.`
                : sanitizeError(roleError);
            } else {
              const roleResult = assertRpcResult<{ error?: string }>(roleData, 'admin_update_profile');
              if (roleResult?.error) activationError = roleResult.error;
            }
          } catch (activationErr: unknown) {
            activationError = sanitizeError(activationErr);
          }
        }
        if (activationError) {
          toast('error', activationError.startsWith('Another user')
            ? activationError
            : `The login ${newEmail} was created but could not be confirmed active (${activationError}). Check it in the list; if it is not active, open it, set the name and role, and mark it active.`);
          if (profile) logActivity({ event: 'user_created', description: `User ${newEmail} created but not activated`, performedBy: profile.id });
          setUserModalOpen(false);
          fetchUsers();
          setCreatingUser(false);
          return;
        }
        newUserRoleIdem.resetKeyFor(newUserId);
        toast('success', 'User created successfully');
        if (profile) logActivity({ event: 'user_created', description: `User ${newName} (${newRole}) created`, performedBy: profile.id });
        setUserModalOpen(false);
        setNewEmail('');
        setNewName('');
        setNewPassword('');
        setNewRole('sales_rep');
        setNewPhone('');
        fetchUsers();
      }
    } catch (err) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'create_user' } });
      toast('error', err instanceof Error ? err.message : 'Failed to create user');
    }
    setCreatingUser(false);
  };

  const openEditModal = (user: Profile) => {
    setEditingUser(user);
    setEditName(user.full_name);
    setEditRole(user.role);
    setEditPhone(user.phone || '');
    setEditIsActive(user.is_active);
    setEditDeniedPages(user.denied_pages || []);
    setEditModalOpen(true);
  };

  // When role changes, prune denied pages that don't apply to the new role
  const handleEditRoleChange = useCallback((newRoleValue: UserRole) => {
    setEditRole(newRoleValue);
    if (newRoleValue === 'admin') {
      setEditDeniedPages([]);
    } else {
      const validKeys = getPagesForRole(newRoleValue).map((p) => p.key);
      setEditDeniedPages((prev) => prev.filter((k) => validKeys.includes(k)));
    }
  }, []);

  const editChanged = editingUser !== null && (
    editName !== editingUser.full_name
    || editRole !== editingUser.role
    || editPhone !== (editingUser.phone || '')
    || editIsActive !== editingUser.is_active
    || [...editDeniedPages].sort().join('|') !== [...(editingUser.denied_pages || [])].sort().join('|')
  );

  // Changes that take access away or hand it out are confirmed before they are saved.
  const pagesGranted = editingUser && editRole !== 'admin'
    ? (editingUser.denied_pages || []).filter((key) => !editDeniedPages.includes(key)).length
    : 0;
  const pagesRemoved = editingUser && editRole !== 'admin'
    ? editDeniedPages.filter((key) => !(editingUser.denied_pages || []).includes(key)).length
    : 0;
  const editWarnings = editingUser ? [
    editRole !== editingUser.role
      && `Change ${editName}'s role from ${ROLE_LABELS[editingUser.role]} to ${ROLE_LABELS[editRole]}; the pages they can open change with it.`,
    editRole === editingUser.role && pagesGranted > 0
      && `Give ${editName} access to ${pagesGranted} more page${pagesGranted === 1 ? '' : 's'}.`,
    editRole === editingUser.role && pagesRemoved > 0
      && `Remove ${editName}'s access to ${pagesRemoved} page${pagesRemoved === 1 ? '' : 's'}.`,
    editIsActive && !editingUser.is_active
      && `Reactivate ${editName}: they will be able to sign in again.`,
    !editIsActive && editingUser.is_active
      && `Deactivate ${editName}: they will be signed out of any open sessions and blocked from signing in again. Reactivating them restores access.`,
    editingUser.id === profile?.id && (editRole !== 'admin' || !editIsActive)
      && 'This is your own account: you will lose access to Settings as soon as you save.',
  ].filter((w): w is string => Boolean(w)) : [];

  const handleEditUser = async () => {
    if (!editingUser || !editChanged) return;
    if (editWarnings.length > 0) {
      setEditConfirmOpen(true);
      return;
    }
    await executeEditUser();
  };

  const executeEditUser = async () => {
    if (!editingUser) return;
    setEditConfirmOpen(false);
    setSavingUser(true);
    try {
      const idemKey = adminUpdateIdem.getKey();
      const { data, error } = await supabase.rpc('admin_update_profile', {
        target_user_id: editingUser.id,
        new_role: editRole,
        new_full_name: editName,
        new_phone: editPhone || undefined,
        new_is_active: editIsActive,
        new_denied_pages: editRole === 'admin' ? [] : editDeniedPages,
        p_idempotency_key: idemKey,
      });
      if (error) {
        // trg_guard_last_active_admin refuses to deactivate the last active admin,
        // which would otherwise lock the account out of its own app.
        toast('error', /LAST_ACTIVE_ADMIN/.test(String((error as { message?: string })?.message ?? ''))
          ? 'You cannot deactivate the only active admin. Make someone else an active admin first.'
          : sanitizeError(error));
      } else {
        const updateResult = assertRpcResult<{ error?: string }>(data, 'admin_update_profile');
        if (updateResult?.error) {
          toast('error', updateResult.error);
        } else {
          adminUpdateIdem.resetKey();
          toast('success', 'User updated successfully');
          if (profile) logActivity({ event: 'user_updated', description: `User ${editName} updated (role: ${editRole}, active: ${editIsActive})`, performedBy: profile.id });
          setEditModalOpen(false);
          setEditingUser(null);
          fetchUsers();
        }
      }
    } catch {
      toast('error', 'Failed to update user');
    }
    setSavingUser(false);
  };

  const openPasswordModal = (user: Profile) => {
    setPasswordTarget(user);
    setAdminSetPassword('');
    setAdminConfirmPassword('');
    setPasswordModalOpen(true);
  };

  const handleSetPassword = async () => {
    if (!passwordTarget) return;
    if (adminSetPassword.length < 8) {
      toast('error', 'Password must be at least 8 characters');
      return;
    }
    if (adminSetPassword !== adminConfirmPassword) {
      toast('error', 'Passwords do not match');
      return;
    }
    setSettingPassword(true);
    try {
      const session = (await supabase.auth.getSession()).data.session;
      if (!session) {
        toast('error', 'You are not logged in. Please sign in again.');
        setSettingPassword(false);
        return;
      }

      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/create-user`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.access_token}`,
            'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
          },
          body: JSON.stringify({
            action: 'reset_password',
            user_id: passwordTarget.id,
            password: adminSetPassword,
          }),
        }
      );

      const data = await response.json();
      if (!response.ok || data?.error) {
        toast('error', data?.error || `Request failed (${response.status})`);
      } else {
        toast('success', `Password updated for ${passwordTarget.full_name}`);
        if (profile) logActivity({ event: 'user_password_reset', description: `Admin reset password for ${passwordTarget.full_name}`, performedBy: profile.id });
        setPasswordModalOpen(false);
        setPasswordTarget(null);
        setAdminSetPassword('');
        setAdminConfirmPassword('');
      }
    } catch (err) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'admin_reset_password' } });
      toast('error', err instanceof Error ? err.message : 'Failed to set password');
    }
    setSettingPassword(false);
  };

  if (role !== 'admin') return null;

  if (pageLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-48 w-full rounded-xl" />
        <Skeleton className="h-64 w-full rounded-xl" />
        <Skeleton className="h-32 w-full rounded-xl" />
      </div>
    );
  }

  const settingsReady = !settingsLoadError && settingsLoaded;
  const addUserButton = (
    <Button size="sm" icon={<UserPlus className="w-4 h-4" />} onClick={() => setUserModalOpen(true)}>
      Add User
    </Button>
  );

  return (
    <div className="phone-touch space-y-5">
      <header>
        <h1 className="font-heading text-4xl font-bold leading-none text-nav-dark">
          App <span className="split-heading-accent">Settings</span>
        </h1>
        <p className="mt-1.5 text-sm text-secondary">Company-wide settings and who can sign in. Changes apply to everyone.</p>
      </header>

      {settingsReady && (
        <SectionJumpBar
          sections={[
            { id: 'settings-users', label: 'Users', count: users.length },
            { id: 'settings-billing', label: 'Billing' },
            { id: 'settings-field', label: 'Field jobs' },
            { id: 'settings-company', label: 'Company' },
          ]}
        />
      )}

      <SettingsSection id="settings-users" icon={<Users className="w-5 h-5" />} title="Users" action={addUserButton}>
        {usersLoadError ? (
          <LoadFailedState title="Users could not be loaded" onRetry={() => void fetchUsers()} />
        ) : users.length === 0 ? (
          <EmptyState
            icon={<Users className="w-6 h-6 text-gray-500" />}
            title="No users found"
            description="Add your first team member to get started."
            action={addUserButton}
          />
        ) : (
          <>
            {/* Phones: one list, a row per person. */}
            <ul className="divide-y divide-gray-100 md:hidden">
              {users.map((u) => (
                <li key={u.id} className="flex items-center gap-3 px-4 py-2.5">
                  <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-nav-dark text-xs font-semibold text-white">
                    {initials(u.full_name)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold text-nav-dark">{u.full_name}</p>
                    <p className="truncate text-xs text-secondary">
                      {ROLE_LABELS[u.role]} · {pageAccessLabel(u)}
                      {!u.is_active && <span className="font-semibold text-gray-700"> · Inactive</span>}
                    </p>
                  </div>
                  <Button size="sm" variant="secondary" onClick={() => openEditModal(u)} aria-label={`Edit ${u.full_name}`}>
                    Edit
                  </Button>
                </li>
              ))}
            </ul>
            {/* relative: keeps the sr-only header label inside the scroll box instead of widening the page. */}
            <div className="relative hidden overflow-x-auto md:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200">
                    <th className="px-4 py-2 text-left font-semibold text-secondary">Name</th>
                    <th className="px-4 py-2 text-left font-semibold text-secondary">Email</th>
                    <th className="px-4 py-2 text-left font-semibold text-secondary">Role</th>
                    <th className="px-4 py-2 text-left font-semibold text-secondary">Phone</th>
                    <th className="px-4 py-2 text-left font-semibold text-secondary">Page access</th>
                    <th className="px-4 py-2 text-left font-semibold text-secondary">Status</th>
                    <th className="px-4 py-2"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {users.map((u) => (
                    <tr key={u.id}>
                      <td className="whitespace-nowrap px-4 py-2 font-semibold text-nav-dark">
                        <span aria-hidden="true" className="mr-2.5 inline-flex h-[30px] w-[30px] items-center justify-center rounded-full bg-nav-dark align-middle text-xs font-semibold text-white">
                          {initials(u.full_name)}
                        </span>
                        {u.full_name}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2 text-secondary">{u.email}</td>
                      <td className="whitespace-nowrap px-4 py-2">{ROLE_LABELS[u.role]}</td>
                      <td className="whitespace-nowrap px-4 py-2">{u.phone || '-'}</td>
                      <td className="whitespace-nowrap px-4 py-2">{pageAccessLabel(u)}</td>
                      <td className="px-4 py-2">
                        <Badge variant={u.is_active ? 'success' : 'default'}>
                          {u.is_active ? 'Active' : 'Inactive'}
                        </Badge>
                      </td>
                      <td className="px-4 py-2 text-right">
                        <Button
                          size="sm"
                          variant="secondary"
                          icon={<Pencil className="w-3.5 h-3.5" />}
                          onClick={() => openEditModal(u)}
                          aria-label={`Edit ${u.full_name}`}
                        >
                          Edit
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </SettingsSection>

      {settingsLoadError ? (
        <Card>
          <LoadFailedState
            title="Settings could not be loaded"
            onRetry={() => void fetchSettings()}
          />
        </Card>
      ) : !settingsLoaded ? null : (
      <>
      <SettingsSection id="settings-billing" icon={<Receipt className="w-5 h-5" />} title="Billing">
        <SubPart
          title="Fuel surcharge"
          help="Off by default. Added to field-application invoices only when it is on and you enter your own rate; CropRX never sets one for you."
          dirty={isDirty('fuel')}
          saveButton={<SaveButton label="Save fuel surcharge" dirty={isDirty('fuel')} saving={savingFuel} onClick={saveFuelSurcharge} />}
        >
          <Row label="Add to new invoices" htmlFor="fuel-enabled">
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input
                id="fuel-enabled"
                type="checkbox"
                checked={fuelSurcharge.enabled}
                onChange={(e) => setFuelSurcharge((c) => ({ ...c, enabled: e.target.checked }))}
                className={CHECK_CLASS}
              />
              On
            </label>
          </Row>
          <Row label="Basis and rate" htmlFor="fuel-basis">
            <select
              id="fuel-basis"
              value={fuelSurcharge.basis}
              onChange={(e) =>
                setFuelSurcharge((c) => ({ ...c, basis: e.target.value as FuelSurchargeBasis }))
              }
              disabled={!fuelSurcharge.enabled}
              className={`${FIELD_CLASS} min-w-0 flex-1 basis-56`}
            >
              <option value="">Select a basis…</option>
              <option value="per_acre">Per acre ($/acre applied)</option>
              <option value="percent">Percent of invoice (% of the bill)</option>
              <option value="flat">Flat amount ($ per invoice)</option>
            </select>
            <span className="inline-flex items-center gap-2">
              <input
                aria-label={`Rate${fuelSurcharge.basis ? ` (${fuelSurchargeRateUnit(fuelSurcharge.basis)})` : ''}`}
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                placeholder="Blank = none"
                value={fuelSurcharge.rate}
                onChange={(e) => setFuelSurcharge((c) => ({ ...c, rate: e.target.value }))}
                disabled={!fuelSurcharge.enabled}
                className={`${FIELD_CLASS} w-32`}
              />
              {fuelSurcharge.basis && <span className="text-[13px] text-secondary">{fuelSurchargeRateUnit(fuelSurcharge.basis)}</span>}
            </span>
          </Row>
          <Row label="Status">
            {fuelSurchargeIsActive(fuelSurcharge) ? (
              <span className="font-medium text-amber-700">
                Active: a &ldquo;Fuel Surcharge&rdquo; line will be added to new field-application invoices.
              </span>
            ) : (
              <span className="text-secondary">Inert: no surcharge will be applied (off, or no rate entered).</span>
            )}
          </Row>
        </SubPart>

        {/* §4: Auto-invoice on job completion (DRAFTS ONLY — never auto-posts). */}
        <SubPart
          title="Automatic invoice drafts"
          help="Drafts only, never posted on their own. A draft waits in Ready to Post on the Office Cockpit for someone to check and post. If pricing can't be worked out, the job still completes and the office is told to bill it by hand."
          dirty={isDirty('autoDraft')}
          saveButton={<SaveButton label="Save invoice drafts" dirty={isDirty('autoDraft')} saving={savingAutoDraft} onClick={saveAutoDraft} />}
        >
          <Row label="When a job is completed" htmlFor="auto-draft-enabled">
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input
                id="auto-draft-enabled"
                type="checkbox"
                checked={autoDraftEnabled}
                onChange={(e) => setAutoDraftEnabled(e.target.checked)}
                className={CHECK_CLASS}
              />
              Create a draft invoice
            </label>
          </Row>
        </SubPart>

        <SubPart
          title="Reminders and quote defaults"
          help="Quotes valid for sets where a quote’s “Pick a date” expiry starts (quotes still default to season end). New customers start on the Default price tier."
          dirty={isDirty('defaults')}
          saveButton={<SaveButton label="Save defaults" dirty={isDirty('defaults')} saving={savingDefaults} onClick={saveDefaults} />}
        >
          {/* AR reminder threshold. NOTE: takes effect only once parked migration
              20260702162000 is applied live (get_ar_reminder_candidates reads
              app_settings.ar_reminder_days). Apply that migration before/with this deploy. */}
          <Row label="Remind when unpaid after" htmlFor="ar-reminder-days">
            <input
              id="ar-reminder-days"
              type="number"
              min="1"
              max="3650"
              inputMode="numeric"
              value={arReminderDays}
              onChange={(e) => setArReminderDays(e.target.value)}
              className={`${FIELD_CLASS} w-24`}
            />
            <span className="text-[13px] text-secondary">days past due</span>
          </Row>
          <Row label="Quotes valid for" htmlFor="default-valid-days">
            <input
              id="default-valid-days"
              type="number"
              min="1"
              inputMode="numeric"
              value={defaultValidDays}
              onChange={(e) => setDefaultValidDays(e.target.value)}
              className={`${FIELD_CLASS} w-24`}
            />
            <span className="text-[13px] text-secondary">days</span>
          </Row>
          <Row label="Default price tier" htmlFor="default-tier">
            <select
              id="default-tier"
              value={defaultTier}
              onChange={(e) => setDefaultTier(e.target.value)}
              className={`${FIELD_CLASS} w-36`}
            >
              <option value="1">Tier 1</option>
              <option value="2">Tier 2</option>
              <option value="3">Tier 3</option>
            </select>
          </Row>
        </SubPart>

        <SubPart
          title="Sales tax"
          help="A chemical sale with its sales tax box ticked is taxed at this rate, on its products and charges after any standing discount. A draft keeps the rate it was taxed at; a new rate applies to new drafts."
          dirty={isDirty('salesTax')}
          saveButton={<SaveButton label="Save sales tax" dirty={isDirty('salesTax')} saving={savingSalesTax} onClick={saveSalesTax} />}
        >
          <Row label="Sales tax rate" htmlFor="sales-tax-rate">
            <input
              id="sales-tax-rate"
              type="text"
              inputMode="decimal"
              value={salesTaxRate}
              onChange={(e) => setSalesTaxRate(e.target.value)}
              className={`${FIELD_CLASS} w-24`}
            />
            <span className="text-[13px] text-secondary">%</span>
          </Row>
        </SubPart>
      </SettingsSection>

      <SettingsSection id="settings-field" icon={<Sprout className="w-5 h-5" />} title="Field jobs">
        {/* §5: Label-rate guardrail mode (WARN by default — never blocks a save). */}
        <SubPart
          title="Label-rate guardrail"
          help="Checks each chemical's per-acre rate in a tank mix against its maximum label rate, and shows the re-entry (REI) and pre-harvest (PHI) windows. A product with no label rate on file is never blocked."
          dirty={isDirty('guardrail')}
          saveButton={<SaveButton label="Save guardrail" dirty={isDirty('guardrail')} saving={savingGuardrail} onClick={saveGuardrailMode} />}
        >
          <Row label="Over the label rate">
            <div role="radiogroup" aria-label="Over the label rate" className="flex flex-col gap-1.5">
              <label className="inline-flex items-center gap-2 cursor-pointer max-md:min-h-11">
                <input
                  type="radio"
                  name="guardrail-mode"
                  checked={guardrailMode === 'warn'}
                  onChange={() => setGuardrailMode('warn')}
                  className="w-4 h-4 border-gray-300 text-crx-green focus:ring-crx-green/20"
                />
                <span><strong className="font-semibold">Warn</strong> &mdash; flag it; the mix still saves (recommended)</span>
              </label>
              <label className="inline-flex items-center gap-2 cursor-pointer max-md:min-h-11">
                <input
                  type="radio"
                  name="guardrail-mode"
                  checked={guardrailMode === 'block'}
                  onChange={() => setGuardrailMode('block')}
                  className="w-4 h-4 border-gray-300 text-crx-green focus:ring-crx-green/20"
                />
                <span><strong className="font-semibold">Block</strong> &mdash; an admin must override with a logged reason before saving</span>
              </label>
            </div>
          </Row>
        </SubPart>

        {/* #9: Custom applicator field-sheet layout (LAYOUT ONLY). */}
        <SubPart
          title="Applicator field sheet"
          help="Layout only: the header, logo, footer and optional columns of the Custom Applicator Report. It never changes a chemical, rate, acre or billing figure. Blank fields use the standard CropRX header."
          dirty={isDirty('sheet')}
          saveButton={<SaveButton label="Save field sheet" dirty={isDirty('sheet')} saving={savingSheet} onClick={saveSheetConfig} />}
        >
          <Row label="Header company name" htmlFor="sheet-company-name">
            <input
              id="sheet-company-name"
              placeholder="Blank = Crop RX Solutions"
              value={sheetConfig.company_name}
              onChange={(e) => setSheetConfig((c) => ({ ...c, company_name: e.target.value }))}
              className={`${FIELD_CLASS} min-w-0 flex-1 basis-64`}
            />
          </Row>
          <Row label="Header address" htmlFor="sheet-company-address">
            <input
              id="sheet-company-address"
              placeholder="Blank = West York, IL"
              value={sheetConfig.company_address}
              onChange={(e) => setSheetConfig((c) => ({ ...c, company_address: e.target.value }))}
              className={`${FIELD_CLASS} min-w-0 flex-1 basis-64`}
            />
          </Row>
          <Row label="Footer text" htmlFor="sheet-footer">
            <input
              id="sheet-footer"
              placeholder="An extra line under the standard footer"
              value={sheetConfig.footer_text}
              onChange={(e) => setSheetConfig((c) => ({ ...c, footer_text: e.target.value }))}
              className={`${FIELD_CLASS} min-w-0 flex-1 basis-64`}
            />
          </Row>
          <Row label="Header logo" htmlFor="sheet-logo">
            <input
              id="sheet-logo"
              type="file"
              accept="image/png,image/jpeg"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                if (file.size > 500 * 1024) {
                  toast('error', 'Logo must be under 500 KB');
                  return;
                }
                const reader = new FileReader();
                reader.onload = () => setSheetConfig((c) => ({ ...c, logo_data_url: typeof reader.result === 'string' ? reader.result : '' }));
                reader.readAsDataURL(file);
              }}
              className="min-w-0 max-w-full text-sm"
            />
            {sheetConfig.logo_data_url && (
              <>
                <img src={sheetConfig.logo_data_url} alt="Logo preview" className="h-9 object-contain" />
                <Button size="sm" variant="secondary" onClick={() => setSheetConfig((c) => ({ ...c, logo_data_url: '' }))}>
                  Remove logo
                </Button>
              </>
            )}
          </Row>
          <Row label="Optional columns">
            {([
              ['crop', 'Crop'],
              ['pest', 'Pest'],
              ['total_applied', 'Total Applied'],
              ['gl_lb', 'gal/lb Equivalent'],
              ['rei', 'REI'],
              ['phi', 'PHI'],
            ] as [keyof ApplicatorSheetCustomConfig['columns'], string][]).map(([key, label]) => (
              <label key={key} className="inline-flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={sheetConfig.columns[key]}
                  onChange={() => toggleSheetColumn(key)}
                  className={CHECK_CLASS}
                />
                {label}
              </label>
            ))}
          </Row>
        </SubPart>

        {/* #40/#41: editable pre- and post-application customer notice wording. */}
        <SubPart
          title="Customer notices"
          help={<>Emailed when you press <strong>Send Pre-Notification</strong> on a job (before) or <strong>Send Post-Notification</strong> on a completed job or its invoice (after).</>}
          dirty={isDirty('notices')}
          saveButton={<SaveButton label="Save notices" dirty={isDirty('notices')} saving={savingNotices} onClick={saveNoticeTemplates} />}
        >
          <Row label="Fill-ins">
            {['{{customer}}', '{{job_number}}', '{{job_date}}'].map((ph) => (
              <code key={ph} className="rounded bg-cream-dark px-1.5 py-0.5 text-[13px] text-nav-dark">{ph}</code>
            ))}
            <span className="text-[13px] text-secondary">are filled in for each customer.</span>
          </Row>
          <Row label="Before spraying" htmlFor="pre-notice-subject">
            <div className="flex w-full flex-col gap-1.5">
              <input
                id="pre-notice-subject"
                value={preNoticeTemplate.subject}
                onChange={(e) => setPreNoticeTemplate((t) => ({ ...t, subject: e.target.value }))}
                placeholder="Upcoming application on your fields"
                className={`${FIELD_CLASS} w-full`}
              />
              <textarea
                aria-label="Before spraying message"
                value={preNoticeTemplate.body}
                onChange={(e) => setPreNoticeTemplate((t) => ({ ...t, body: e.target.value }))}
                rows={5}
                className={TEXTAREA_CLASS}
                placeholder="Hello {{customer}}, ..."
              />
            </div>
          </Row>
          <Row label="After spraying" htmlFor="post-notice-subject">
            <div className="flex w-full flex-col gap-1.5">
              <input
                id="post-notice-subject"
                value={postNoticeTemplate.subject}
                onChange={(e) => setPostNoticeTemplate((t) => ({ ...t, subject: e.target.value }))}
                placeholder="Your field application is complete"
                className={`${FIELD_CLASS} w-full`}
              />
              <textarea
                aria-label="After spraying message"
                value={postNoticeTemplate.body}
                onChange={(e) => setPostNoticeTemplate((t) => ({ ...t, body: e.target.value }))}
                rows={5}
                className={TEXTAREA_CLASS}
                placeholder="Hello {{customer}}, ..."
              />
            </div>
          </Row>
        </SubPart>
      </SettingsSection>

      <SettingsSection
        id="settings-company"
        icon={<Building2 className="w-5 h-5" />}
        title="Company"
        action={<SaveButton label="Save company details" dirty={isDirty('company')} saving={savingCompany} onClick={saveCompanyInfo} />}
      >
        <div className="border-t border-gray-200 px-4 pt-2">
          <p className="text-[13px] text-secondary">
            Printed on quote and invoice PDFs, including emailed invoices. A blank field prints the standard detail.
            <UnsavedChip show={isDirty('company')} />
          </p>
        </div>
        <Row label="Company name" htmlFor="company-name">
          <input
            id="company-name"
            name="company_name"
            autoComplete="off"
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            className={`${FIELD_CLASS} min-w-0 flex-1 basis-64`}
          />
        </Row>
        <Row label="Phone and email" htmlFor="company-phone">
          <input
            id="company-phone"
            name="company_phone"
            type="tel"
            autoComplete="off"
            aria-label="Company phone"
            value={companyPhone}
            onChange={(e) => setCompanyPhone(e.target.value)}
            className={`${FIELD_CLASS} min-w-0 flex-1 basis-40`}
          />
          <input
            name="company_email"
            type="email"
            autoComplete="off"
            aria-label="Company email"
            value={companyEmail}
            onChange={(e) => setCompanyEmail(e.target.value)}
            className={`${FIELD_CLASS} min-w-0 flex-1 basis-52`}
          />
        </Row>
        <Row label="Address" htmlFor="company-address">
          <input
            id="company-address"
            name="company_address"
            autoComplete="off"
            value={companyAddress}
            onChange={(e) => setCompanyAddress(e.target.value)}
            className={`${FIELD_CLASS} min-w-0 flex-1 basis-64`}
          />
        </Row>
      </SettingsSection>
      </>
      )}

      <Modal open={userModalOpen} onClose={() => setUserModalOpen(false)} title="Add" accent="User">
        <div className="space-y-4">
          <Input label="Full Name" value={newName} onChange={(e) => setNewName(e.target.value)} autoComplete="off" />
          {/* The browser must not fill in the signed-in admin's own saved login here. */}
          <Input label="Email" type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} autoComplete="off" />
          <Input label="Password" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="Min 6 characters" autoComplete="new-password" />
          <div>
            <label htmlFor="new-user-role" className="block text-sm font-medium text-secondary mb-1">Role</label>
            <select
              id="new-user-role"
              value={newRole}
              onChange={(e) => setNewRole(e.target.value as UserRole)}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            >
              <option value="admin">Admin</option>
              <option value="sales_rep">Sales Rep</option>
              <option value="driver">Driver</option>
              <option value="applicator">Applicator</option>
            </select>
          </div>
          <Input label="Phone" type="tel" value={newPhone} onChange={(e) => setNewPhone(e.target.value)} autoComplete="off" />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setUserModalOpen(false)}>Cancel</Button>
            <Button onClick={handleCreateUser} loading={creatingUser}>Create User</Button>
          </div>
        </div>
      </Modal>

      <Modal open={editModalOpen} onClose={() => setEditModalOpen(false)} title="Edit" accent="User" size="large">
        <div className="space-y-4">
          {editingUser && (
            <p className="text-sm text-secondary">
              {editingUser.email}
              {editingUser.id === profile?.id && <span className="font-semibold text-nav-dark"> (you)</span>}
            </p>
          )}
          <Input label="Full Name" value={editName} onChange={(e) => setEditName(e.target.value)} autoComplete="off" />
          <div>
            <label htmlFor="edit-user-role" className="block text-sm font-medium text-secondary mb-1">Role</label>
            <select
              id="edit-user-role"
              value={editRole}
              onChange={(e) => handleEditRoleChange(e.target.value as UserRole)}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            >
              <option value="admin">Admin</option>
              <option value="sales_rep">Sales Rep</option>
              <option value="driver">Driver</option>
              <option value="applicator">Applicator</option>
            </select>
          </div>
          <Input label="Phone" type="tel" value={editPhone} onChange={(e) => setEditPhone(e.target.value)} autoComplete="off" />
          <div>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={editIsActive}
                onChange={(e) => setEditIsActive(e.target.checked)}
                className={CHECK_CLASS}
              />
              <span className="text-sm font-medium text-secondary">Active (can sign in)</span>
            </label>
          </div>

          <UserPermissionsPanel
            role={editRole}
            deniedPages={editDeniedPages}
            onChange={setEditDeniedPages}
          />

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-gray-100 pt-3">
            <div>
              {editingUser && (
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<KeyRound className="w-3.5 h-3.5" />}
                  onClick={() => { setEditModalOpen(false); openPasswordModal(editingUser); }}
                >
                  Set Password
                </Button>
              )}
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => setEditModalOpen(false)}>Cancel</Button>
              <Button onClick={handleEditUser} loading={savingUser} disabled={!editChanged}>Save Changes</Button>
            </div>
          </div>
        </div>
      </Modal>

      <ConfirmModal
        open={editConfirmOpen}
        onClose={() => setEditConfirmOpen(false)}
        onConfirm={executeEditUser}
        title="Confirm User Changes"
        message={editWarnings.join(' ')}
        confirmLabel={!editIsActive && editingUser?.is_active ? 'Deactivate' : 'Save Changes'}
        variant="warning"
      />

      <Modal open={passwordModalOpen} onClose={() => setPasswordModalOpen(false)} title="Set" accent="Password">
        <div className="space-y-4">
          {passwordTarget && (
            <p className="text-sm text-secondary">
              Setting a new password for <strong>{passwordTarget.full_name}</strong> ({passwordTarget.email})
            </p>
          )}
          {/* new-password: the browser offers to generate one rather than filling in the admin's own. */}
          <Input
            label="New Password"
            type="password"
            value={adminSetPassword}
            onChange={(e) => setAdminSetPassword(e.target.value)}
            placeholder="At least 8 characters"
            autoComplete="new-password"
          />
          <Input
            label="Confirm Password"
            type="password"
            value={adminConfirmPassword}
            onChange={(e) => setAdminConfirmPassword(e.target.value)}
            placeholder="Re-enter the password"
            autoComplete="new-password"
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setPasswordModalOpen(false)}>Cancel</Button>
            <Button onClick={handleSetPassword} loading={settingPassword}>Update Password</Button>
          </div>
        </div>
      </Modal>

      <UnsavedChangesModal
        open={blocker.state === 'blocked'}
        onStay={() => blocker.reset?.()}
        onLeave={() => blocker.proceed?.()}
      />
    </div>
  );
}
