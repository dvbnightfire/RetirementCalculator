import React, { useState, useMemo, useCallback, useEffect } from 'react';
import {
  TrendingUp, TrendingDown, AlertTriangle, ShieldAlert,
  Plus, Trash2, CheckCircle2, XCircle, ChevronRight, ChevronDown,
  MapPin, Heart, Sparkles, ArrowRight, ArrowLeft, Sun, Users, Wallet,
  PiggyBank, GraduationCap, Calendar, Save, FolderOpen, Copy, Download, FileText, Lock
} from 'lucide-react';

// ─── UTILITIES ──────────────────────────────────────────────

const formatCurrency = (value) => {
  if (Math.abs(value) >= 1000000) return `$${(value / 1000000).toFixed(2)}M`;
  if (Math.abs(value) >= 1000) return `$${Math.round(value / 1000)}K`;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);
};

const formatCurrencyFull = (value) => {
  if (Math.abs(value) >= 1000000) return `$${(value / 1000000).toFixed(2)}M`;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);
};

const possessiveLabel = (name, fallback = 'Your') => {
  const trimmed = (name || '').trim();
  if (!trimmed) return fallback;
  return trimmed.endsWith('s') ? `${trimmed}'` : `${trimmed}'s`;
};

const getRetirementAges = ({ hasSpouse, currentAge, spouseAge, primaryRetirementAge, spouseRetirementAge }) => {
  const primary = Math.max(primaryRetirementAge ?? currentAge + 1, currentAge + 1);
  if (!hasSpouse) {
    return { primary, spouse: null, first: primary, final: primary };
  }

  const normalizedSpouseAge = spouseAge ?? currentAge;
  const spouse = Math.max(spouseRetirementAge ?? primary, normalizedSpouseAge + 1);
  return {
    primary,
    spouse,
    first: Math.min(primary, spouse),
    final: Math.max(primary, spouse),
  };
};

const getWorkStatusAtAge = ({ age, hasSpouse, primaryRetirementAge, spouseRetirementAge }) => {
  const primaryWorking = age < primaryRetirementAge;
  const spouseWorking = hasSpouse ? age < spouseRetirementAge : false;
  return {
    primaryWorking,
    spouseWorking,
    anyWorking: primaryWorking || spouseWorking,
    anyRetired: !primaryWorking || (hasSpouse && !spouseWorking),
    allRetired: !primaryWorking && (!hasSpouse || !spouseWorking),
  };
};

const getContributionPlanForAge = ({
  age,
  hasSpouse,
  myIncome,
  spouseIncome,
  primaryRetirementAge,
  spouseRetirementAge,
  my401k,
  spouse401k,
  rothIRA,
  hsa,
  plan529,
  otherSavings,
}) => {
  const workStatus = getWorkStatusAtAge({ age, hasSpouse, primaryRetirementAge, spouseRetirementAge });
  const totalBaseIncome = myIncome + (hasSpouse ? spouseIncome : 0);
  const activeBaseIncome = (workStatus.primaryWorking ? myIncome : 0) + (workStatus.spouseWorking ? spouseIncome : 0);
  const householdRatio = totalBaseIncome > 0 ? activeBaseIncome / totalBaseIncome : (workStatus.anyWorking ? 1 : 0);
  const taxDeferred = (workStatus.primaryWorking ? my401k : 0) + (workStatus.spouseWorking ? spouse401k : 0);
  const taxFree = (rothIRA + hsa) * householdRatio;
  const education = plan529 * householdRatio;
  const taxable = otherSavings * householdRatio;

  return {
    ...workStatus,
    activeBaseIncome,
    householdRatio,
    taxDeferred,
    taxFree,
    education,
    taxable,
    total: taxDeferred + taxFree + education + taxable,
  };
};

const formatRetirementLabel = ({ hasSpouse, primaryLabel, spouseLabel, primaryRetirementAge, spouseRetirementAge }) => {
  if (!hasSpouse) return `Age ${primaryRetirementAge}`;
  if (primaryRetirementAge === spouseRetirementAge) return `Both at age ${primaryRetirementAge}`;
  return `${primaryLabel} ${primaryRetirementAge} · ${spouseLabel} ${spouseRetirementAge}`;
};

const STORAGE_KEY = 'retirement-planner-plans';
const VAULT_VERSION = 1;
const VAULT_ITERATIONS = 250000;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const bytesToBase64 = (bytes) => {
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
};

const base64ToBytes = (value) => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

const sanitizeFilename = (value) => (value || 'retirement-plan')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '') || 'retirement-plan';

const downloadJsonFile = (payload, filename) => {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
};

const getDisplayedPhaseEndAge = (endAge, planToAge, hasNextPhase) => {
  if (!hasNextPhase && endAge === planToAge + 1) return planToAge;
  return endAge;
};

const getInternalPhaseEndAge = (displayedEndAge, planToAge, hasNextPhase) => {
  if (!hasNextPhase && displayedEndAge === planToAge) return planToAge + 1;
  return displayedEndAge;
};

const uniquifyImportedPlan = (plan, existingPlans, index) => {
  const existingNames = new Set(existingPlans.map((item) => item.name));
  let nextName = plan.name || `Imported plan ${index + 1}`;
  if (existingNames.has(nextName)) nextName = `${nextName} (imported)`;

  return {
    ...plan,
    id: Date.now() + index + Math.random(),
    name: nextName,
    createdAt: plan.createdAt || Date.now(),
    updatedAt: Date.now(),
  };
};

const readStoredVault = () => {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return { type: 'empty' };

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return { type: 'legacy', plans: parsed };
    if (parsed && parsed.version === VAULT_VERSION && parsed.salt && parsed.iv && parsed.ciphertext) {
      return { type: 'encrypted', payload: parsed };
    }
  } catch {
    return { type: 'corrupt' };
  }

  return { type: 'corrupt' };
};

const createVaultConfig = () => ({
  version: VAULT_VERSION,
  iterations: VAULT_ITERATIONS,
  salt: bytesToBase64(globalThis.crypto.getRandomValues(new Uint8Array(16))),
});

const deriveVaultKey = async (passphrase, salt, iterations = VAULT_ITERATIONS) => {
  const keyMaterial = await globalThis.crypto.subtle.importKey(
    'raw',
    textEncoder.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return globalThis.crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: base64ToBytes(salt),
      iterations,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
};

const encryptPlansPayload = async (plans, vaultKey, vaultConfig) => {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const plaintext = textEncoder.encode(JSON.stringify(plans));
  const encrypted = await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, vaultKey, plaintext);
  return {
    version: vaultConfig.version,
    iterations: vaultConfig.iterations,
    salt: vaultConfig.salt,
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(encrypted)),
    updatedAt: Date.now(),
  };
};

const decryptPlansPayload = async (payload, vaultKey) => {
  const decrypted = await globalThis.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(payload.iv) },
    vaultKey,
    base64ToBytes(payload.ciphertext)
  );
  const parsed = JSON.parse(textDecoder.decode(decrypted));
  return Array.isArray(parsed) ? parsed : [];
};

const getSSMultiplier = (age) => {
  if (age === 67) return 1;
  if (age < 67) return Math.max(0.7, 1 - (67 - age) * 0.06);
  if (age > 67) return Math.min(1.24, 1 + (age - 67) * 0.08);
  return 1;
};

// Estimate SS monthly benefit based on annual income (simplified PIA formula)
const estimateSSMonthly = (annualIncome) => {
  // SS replaces ~90% of first $13K, 32% of next $66K, 15% above that (2026 bend points approx)
  const monthlyEarnings = Math.min(annualIncome, 168600) / 12; // SS wage cap
  let pia = 0;
  if (monthlyEarnings <= 1115) {
    pia = monthlyEarnings * 0.9;
  } else if (monthlyEarnings <= 6721) {
    pia = 1115 * 0.9 + (monthlyEarnings - 1115) * 0.32;
  } else {
    pia = 1115 * 0.9 + (6721 - 1115) * 0.32 + (monthlyEarnings - 6721) * 0.15;
  }
  return Math.round(pia);
};

const getExpenseAtAge = (expense, age) => {
  const p = expense.phases.find(p => age >= p.startAge && age < p.endAge);
  return p ? p.amount : 0;
};

const getTotalExpensesAtAge = (expenses, age) =>
  expenses.reduce((sum, exp) => sum + getExpenseAtAge(exp, age), 0);

const getExpensesByTypeAtAge = (expenses, age) => {
  let medical = 0, nonMedical = 0;
  expenses.forEach(exp => {
    const amt = getExpenseAtAge(exp, age);
    if (exp.isMedical) medical += amt; else nonMedical += amt;
  });
  return { medical, nonMedical };
};

const getMilestoneYears = (kid) => {
  const events = [];
  const m = kid.milestones;
  if (m.highSchool.enabled) {
    for (let i = 0; i < m.highSchool.years; i++) {
      events.push({ year: kid.birthYear + m.highSchool.startAge + i, cost: m.highSchool.annualCost, name: `${kid.name} - High School` });
    }
  }
  if (m.college.enabled) {
    for (let i = 0; i < m.college.years; i++) {
      events.push({ year: kid.birthYear + m.college.startAge + i, cost: m.college.annualCost, name: `${kid.name} - College` });
    }
  }
  if (m.wedding.enabled) {
    events.push({ year: kid.birthYear + m.wedding.age, cost: m.wedding.cost, name: `${kid.name} - Wedding` });
  }
  m.custom.forEach(c => {
    for (let i = 0; i < (c.years || 1); i++) {
      events.push({ year: kid.birthYear + c.age + i, cost: c.annualCost, name: `${kid.name} - ${c.name}` });
    }
  });
  return events;
};

const getLocationForSummary = (locationPhases, age, fallbackCountry = 'USA', fallbackState = 'California') => {
  if (!locationPhases || locationPhases.length === 0) {
    return { country: fallbackCountry, state: fallbackState };
  }
  return locationPhases.find(phase => age >= phase.startAge && age < phase.endAge) || locationPhases[locationPhases.length - 1];
};

const getPlanSummary = (plan) => {
  if (!plan) return null;

  const initial = plan.initialData || {};
  const state = plan.state || {};
  const currentAge = state.currentAge ?? initial.age ?? 30;
  const hasSpouse = state.hasSpouse ?? initial.hasSpouse ?? false;
  const myName = state.myName || initial.myName || 'You';
  const spouseName = state.spouseName || initial.spouseName || '';
  const spouseAge = state.spouseAge ?? initial.spouseAge ?? currentAge;
  const { primary, spouse, first, final } = getRetirementAges({
    hasSpouse,
    currentAge,
    spouseAge,
    primaryRetirementAge: state.primaryRetirementAge ?? state.retirementAge ?? initial.primaryRetireAge ?? initial.retireAge ?? currentAge + 25,
    spouseRetirementAge: state.spouseRetirementAge ?? initial.spouseRetireAge ?? state.retirementAge ?? initial.retireAge ?? spouseAge + 25,
  });
  const planToAge = state.planToAge ?? initial.modelToAge ?? Math.max(final + 5, 95);
  const myIncome = state.myIncome ?? initial.myIncome ?? 0;
  const spouseIncome = state.spouseIncome ?? initial.spouseIncome ?? 0;
  const currentSavings = state.currentSavings ?? initial.savings ?? 0;
  const expenses = state.expenses || [];
  const kids = state.kids || [];
  const currentMonthlyExpenses = expenses.length > 0 ? getTotalExpensesAtAge(expenses, currentAge) : 0;
  const currentYearMilestones = kids.flatMap(kid => getMilestoneYears(kid))
    .filter(event => event.year === currentYear)
    .reduce((sum, event) => sum + event.cost, 0);
  const locationPhases = state.locationPhases || [{
    id: 1,
    country: initial.country || 'USA',
    state: initial.state || 'California',
    startAge: initial.age ?? currentAge,
    endAge: planToAge + 1,
  }];
  const currentLoc = getLocationForSummary(locationPhases, currentAge, initial.country || 'USA', initial.state || 'California');
  const contributionPlan = getContributionPlanForAge({
    age: currentAge,
    hasSpouse,
    myIncome,
    spouseIncome,
    primaryRetirementAge: primary,
    spouseRetirementAge: spouse,
    my401k: state.my401k ?? 20000,
    spouse401k: state.spouse401k ?? (hasSpouse ? 15000 : 0),
    rothIRA: state.rothIRA ?? 0,
    hsa: state.hsa ?? 0,
    plan529: state.plan529 ?? 0,
    otherSavings: state.otherSavings ?? 10000,
  });
  const annualIncome = contributionPlan.activeBaseIncome;
  const currentTax = computeCountryTax(annualIncome, currentLoc.country, currentLoc.state);
  const netIncome = annualIncome - currentTax.total;
  const cashFlow = netIncome - (currentMonthlyExpenses * 12) - currentYearMilestones - contributionPlan.total;
  const effectiveTaxRate = annualIncome > 0 ? (currentTax.total / annualIncome) * 100 : 0;

  return {
    id: plan.id,
    name: plan.name,
    updatedAt: plan.updatedAt,
    currentAge,
    primaryRetirementAge: primary,
    spouseRetirementAge: spouse,
    firstRetirementAge: first,
    finalRetirementAge: final,
    planToAge,
    hasSpouse,
    myName,
    spouseName,
    spouseAge,
    annualIncome,
    netIncome,
    currentSavings,
    annualContribution: contributionPlan.total,
    currentMonthlyExpenses,
    currentYearMilestones,
    cashFlow,
    effectiveTaxRate,
    yearsToFirstRetirement: first - currentAge,
    yearsToFullRetirement: final - currentAge,
    planningYearsRemaining: planToAge - currentAge,
    retirementLabel: formatRetirementLabel({
      hasSpouse,
      primaryLabel: myName,
      spouseLabel: spouseName || 'Partner',
      primaryRetirementAge: primary,
      spouseRetirementAge: spouse,
    }),
    locationLabel: currentLoc.country === 'USA'
      ? `${COUNTRY_DATA[currentLoc.country]?.flag} ${currentLoc.state}`
      : `${COUNTRY_DATA[currentLoc.country]?.flag} ${COUNTRY_DATA[currentLoc.country]?.label}`,
  };
};

const US_STATE_TAX_RATES = {
  'California': 13.3, 'New York': 10.9, 'New Jersey': 10.75, 'Oregon': 9.9,
  'Minnesota': 9.85, 'Massachusetts': 9.0, 'Vermont': 8.75, 'Connecticut': 6.99,
  'Hawaii': 11.0, 'Iowa': 6.0, 'Wisconsin': 7.65, 'Maine': 7.15,
  'Idaho': 5.8, 'Colorado': 4.4, 'Illinois': 4.95, 'Michigan': 4.25,
  'Pennsylvania': 3.07, 'Indiana': 3.05, 'Arizona': 2.5, 'North Carolina': 4.5,
  'Georgia': 5.49, 'Virginia': 5.75, 'Ohio': 3.5, 'Utah': 4.65,
  'Texas': 0, 'Florida': 0, 'Nevada': 0, 'Washington': 0,
  'Wyoming': 0, 'Alaska': 0, 'Tennessee': 0, 'South Dakota': 0,
  'New Hampshire': 0,
};

// Progressive state brackets (married filing jointly, 2025) for popular states
const STATE_BRACKETS = {
  'California': [[22158,0.01],[30370,0.02],[30376,0.04],[32180,0.06],[30364,0.08],[597510,0.093],[148584,0.103],[594364,0.113],[Infinity,0.123]],
  'New York': [[17150,0.04],[6450,0.045],[4300,0.0525],[133650,0.055],[161650,0.06],[1832150,0.0685],[2844650,0.0965],[20000000,0.103],[Infinity,0.109]],
  'New Jersey': [[20000,0.014],[15000,0.0175],[15000,0.035],[30000,0.05525],[70000,0.0637],[350000,0.0897],[500000,0.1075],[Infinity,0.1075]],
  'Oregon': [[10750,0.0475],[16300,0.0675],[223250,0.0875],[Infinity,0.099]],
  'Hawaii': [[9600,0.014],[9600,0.032],[19200,0.055],[19200,0.064],[19200,0.068],[24000,0.072],[24000,0.076],[72000,0.079],[Infinity,0.11]],
  'Georgia': [[1500,0.01],[1500,0.02],[1500,0.03],[1500,0.04],[1500,0.05],[Infinity,0.0549]],
  'Virginia': [[6000,0.02],[3000,0.03],[8000,0.05],[Infinity,0.0575]],
  'North Carolina': [[Infinity,0.045]],
  'Arizona': [[Infinity,0.025]],
  'Colorado': [[Infinity,0.044]],
  'Illinois': [[Infinity,0.0495]],
  'Michigan': [[Infinity,0.0425]],
  'Pennsylvania': [[Infinity,0.0307]],
  'Indiana': [[Infinity,0.0305]],
  'Utah': [[Infinity,0.0465]],
  'Massachusetts': [[Infinity,0.09]], // 9% flat (5% + 4% millionaires surtax simplified)
};

const computeStateTax = (income, state) => {
  const brackets = STATE_BRACKETS[state];
  if (brackets) {
    let rem = income, tax = 0;
    for (const [w, r] of brackets) { const t = Math.min(rem, w); tax += t * r; rem -= t; if (rem <= 0) break; }
    // California 1% mental health surcharge on income over $1M
    if (state === 'California' && income > 1000000) tax += (income - 1000000) * 0.01;
    return tax;
  }
  // Fallback: use top marginal rate as flat (overestimates slightly for small states)
  return income * ((US_STATE_TAX_RATES[state] || 0) / 100);
};

const POPULAR_STATES = ['California', 'Texas', 'Florida', 'New York', 'Washington', 'Colorado', 'North Carolina', 'Georgia', 'Arizona', 'Nevada'];

const computeUSFederalTax = (income) => {
  const brackets = [[23850, 0.10], [73400, 0.12], [109450, 0.22], [187900, 0.24], [106450, 0.32], [250550, 0.35], [Infinity, 0.37]];
  let rem = income, tax = 0;
  for (const [w, r] of brackets) { const t = Math.min(rem, w); tax += t * r; rem -= t; if (rem <= 0) break; }
  return tax;
};

const computeIndiaTax = (incomeUSD) => {
  const INR_RATE = 83;
  const incomeINR = incomeUSD * INR_RATE;
  // Section 87A rebate: no tax if income <= 12L
  if (incomeINR <= 1200000) return 0;
  const brackets = [[400000, 0], [400000, 0.05], [400000, 0.10], [400000, 0.15], [400000, 0.20], [400000, 0.25], [Infinity, 0.30]];
  let rem = incomeINR, tax = 0;
  for (const [w, r] of brackets) { const t = Math.min(rem, w); tax += t * r; rem -= t; if (rem <= 0) break; }
  // Surcharge
  if (incomeINR > 50000000) tax *= 1.25;
  else if (incomeINR > 10000000) tax *= 1.15;
  else if (incomeINR > 5000000) tax *= 1.10;
  // 4% Health & Education Cess
  tax *= 1.04;
  return tax / INR_RATE; // convert back to USD
};

const computeSingaporeTax = (incomeUSD) => {
  const SGD_RATE = 1.35;
  const incomeSGD = incomeUSD * SGD_RATE;
  const brackets = [[20000, 0], [10000, 0.02], [10000, 0.035], [40000, 0.07], [40000, 0.115], [40000, 0.15], [40000, 0.18], [40000, 0.19], [40000, 0.195], [40000, 0.20], [180000, 0.22], [500000, 0.23], [Infinity, 0.24]];
  let rem = incomeSGD, tax = 0;
  for (const [w, r] of brackets) { const t = Math.min(rem, w); tax += t * r; rem -= t; if (rem <= 0) break; }
  return tax / SGD_RATE;
};

const COUNTRY_DATA = {
  USA: { label: 'United States', flag: '🇺🇸', hasStates: true, investmentTypes: ['Stocks', 'Bonds'], defaultInflation: 2.5, defaultMedInflation: 4.0 },
  India: { label: 'India', flag: '🇮🇳', hasStates: false, investmentTypes: ['Stocks', 'Fixed Deposits'], defaultFDRate: 7.0, defaultInflation: 5.5, defaultMedInflation: 7.0 },
  Singapore: { label: 'Singapore', flag: '🇸🇬', hasStates: false, investmentTypes: ['Stocks', 'Bonds'], defaultInflation: 2.0, defaultMedInflation: 3.5 },
  UAE: { label: 'UAE', flag: '🇦🇪', hasStates: false, investmentTypes: ['Stocks', 'Bonds'], defaultInflation: 2.5, defaultMedInflation: 3.5 },
};

const computeCountryTax = (income, country, state) => {
  if (country === 'USA') {
    const fedTax = computeUSFederalTax(income);
    const stTax = computeStateTax(income, state);
    const stEff = income > 0 ? (stTax / income * 100).toFixed(1) : '0.0';
    return { total: fedTax + stTax, federal: fedTax, state: stTax, label: `Fed ${(income > 0 ? fedTax/income*100 : 0).toFixed(1)}% + ${state || 'State'} ${stEff}%` };
  }
  if (country === 'India') { const t = computeIndiaTax(income); return { total: t, federal: t, state: 0, label: `India tax ${(income > 0 ? t/income*100 : 0).toFixed(1)}%` }; }
  if (country === 'Singapore') { const t = computeSingaporeTax(income); return { total: t, federal: t, state: 0, label: `SG tax ${(income > 0 ? t/income*100 : 0).toFixed(1)}%` }; }
  if (country === 'UAE') return { total: 0, federal: 0, state: 0, label: '0% tax' };
  return { total: 0, federal: 0, state: 0, label: '' };
};

const currentYear = new Date().getFullYear();

// ─── ONBOARDING WIZARD ─────────────────────────────────────

function OnboardingWizard({ onComplete, planName }) {
  const [step, setStep] = useState(0);
  const [myName, setMyName] = useState('');
  const [age, setAge] = useState(30);
  const [primaryRetireAge, setPrimaryRetireAge] = useState(55);
  const [hasSpouse, setHasSpouse] = useState(false);
  const [spouseName, setSpouseName] = useState('');
  const [spouseAge, setSpouseAge] = useState(30);
  const [spouseRetireAge, setSpouseRetireAge] = useState(55);
  const [country, setCountry] = useState('USA');
  const [state, setState] = useState('California');
  const [myIncome, setMyIncome] = useState(100000);
  const [spouseIncome, setSpouseIncome] = useState(0);
  const [savings, setSavings] = useState(200000);
  const [modelToAge, setModelToAge] = useState(95);
  const normalizedPrimaryRetireAge = Math.max(primaryRetireAge, age + 1);
  const normalizedSpouseRetireAge = hasSpouse ? Math.max(spouseRetireAge, spouseAge + 1) : null;
  const finalRetirementAge = hasSpouse ? Math.max(normalizedPrimaryRetireAge, normalizedSpouseRetireAge) : normalizedPrimaryRetireAge;

  const steps = [
    { title: 'About You', subtitle: 'Let\'s start with the basics', icon: Sun },
    { title: 'Your Finances', subtitle: 'A snapshot of where you are today', icon: Wallet },
    { title: 'Where You\'ll Be', subtitle: 'Location affects taxes and cost of living', icon: MapPin },
    { title: 'Ready!', subtitle: 'Let\'s see your retirement forecast', icon: Sparkles },
  ];

  const canNext = step < 3;
  const canBack = step > 0;
  const totalIncome = myIncome + (hasSpouse ? spouseIncome : 0);
  const stepCanContinue = step !== 0 || (myName.trim().length > 0 && (!hasSpouse || spouseName.trim().length > 0));

  const handleComplete = () => {
    onComplete({
      myName: myName.trim(),
      spouseName: hasSpouse ? spouseName.trim() : '',
      age,
      retireAge: normalizedPrimaryRetireAge,
      primaryRetireAge: normalizedPrimaryRetireAge,
      spouseRetireAge: hasSpouse ? normalizedSpouseRetireAge : null,
      country,
      state: country === 'USA' ? state : null,
      hasSpouse,
      spouseAge,
      myIncome,
      spouseIncome: hasSpouse ? spouseIncome : 0,
      savings,
      modelToAge: Math.max(modelToAge, finalRetirementAge + 5)
    });
  };

  return (
    <div className="min-h-screen bg-cream flex items-center justify-center p-4">
      <div className="w-full max-w-lg">
        {/* Progress dots */}
        <div className="flex justify-center gap-2 mb-8">
          {steps.map((_, i) => (
            <div key={i} className={`h-2 rounded-full transition-all duration-500 ${i === step ? 'w-8 bg-warm-500' : i < step ? 'w-2 bg-warm-300' : 'w-2 bg-cream-dark'}`} />
          ))}
        </div>

        <div className="bg-white rounded-3xl shadow-lg shadow-warm-100/50 border border-warm-100/30 overflow-hidden">
          {/* Header */}
          <div className="bg-gradient-to-br from-warm-50 to-cream p-8 text-center">
            {React.createElement(steps[step].icon, { size: 32, className: 'mx-auto mb-3 text-warm-500' })}
            <p className="text-[11px] uppercase tracking-[0.18em] text-warm-400 mb-2">{planName}</p>
            <h1 className="text-2xl text-warm-900">{steps[step].title}</h1>
            <p className="text-warm-600 mt-1 font-light">{steps[step].subtitle}</p>
          </div>

          {/* Content */}
          <div className="p-8 animate-fade-in" key={step}>
            {step === 0 && (
              <div className="space-y-6">
                <div>
                  <label className="block text-sm font-semibold text-warm-800 mb-2">What should we call you?</label>
                  <input
                    type="text"
                    value={myName}
                    onChange={e => setMyName(e.target.value)}
                    placeholder="Your name"
                    className="w-full border border-warm-200 bg-cream/60 rounded-2xl px-4 py-3 text-base text-warm-800 focus:outline-none focus:border-warm-400 focus:bg-white transition-colors"
                  />
                </div>
                <div>
                  <label className="block text-sm font-semibold text-warm-800 mb-2">How old is {myName.trim() || 'the primary planner'}?</label>
                  <div className="flex items-center gap-4">
                    <input type="range" min={18} max={70} value={age} onChange={e => setAge(Number(e.target.value))} className="flex-1" />
                    <span className="text-2xl font-bold text-warm-700 w-12 text-right font-[family-name:var(--font-display)]">{age}</span>
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-semibold text-warm-800 mb-2">When should {myName.trim() || 'the primary planner'} retire?</label>
                  <div className="flex items-center gap-4">
                    <input type="range" min={age + 1} max={80} value={normalizedPrimaryRetireAge} onChange={e => setPrimaryRetireAge(Number(e.target.value))} className="flex-1" />
                    <span className="text-2xl font-bold text-warm-700 w-12 text-right font-[family-name:var(--font-display)]">{normalizedPrimaryRetireAge}</span>
                  </div>
                  <p className="text-xs text-warm-400 mt-2">That's {normalizedPrimaryRetireAge - age} years from now</p>
                </div>
                <div>
                  <label className="block text-sm font-semibold text-warm-800 mb-2">Model finances until age</label>
                  <div className="flex items-center gap-4">
                    <input type="range" min={finalRetirementAge + 5} max={110} value={Math.max(modelToAge, finalRetirementAge + 5)} onChange={e => setModelToAge(Number(e.target.value))} className="flex-1" />
                    <span className="text-2xl font-bold text-warm-700 w-12 text-right font-[family-name:var(--font-display)]">{Math.max(modelToAge, finalRetirementAge + 5)}</span>
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-semibold text-warm-800 mb-2">Do you have a spouse or partner?</label>
                  <div className="flex gap-2">
                    <button onClick={() => setHasSpouse(true)}
                      className={`flex-1 py-2.5 rounded-xl text-sm font-medium transition-all ${hasSpouse
                        ? 'bg-warm-500 text-white shadow-md shadow-warm-200'
                        : 'bg-cream hover:bg-warm-50 text-warm-700 border border-warm-100'}`}>
                      <Heart size={14} className="inline mr-1.5 -mt-0.5" />Yes
                    </button>
                    <button onClick={() => setHasSpouse(false)}
                      className={`flex-1 py-2.5 rounded-xl text-sm font-medium transition-all ${!hasSpouse
                        ? 'bg-warm-500 text-white shadow-md shadow-warm-200'
                        : 'bg-cream hover:bg-warm-50 text-warm-700 border border-warm-100'}`}>
                      No
                    </button>
                  </div>
                </div>
                {hasSpouse && (
                  <div className="bg-warm-50 rounded-xl p-4 space-y-4 animate-fade-in">
                    <div>
                      <label className="block text-sm font-semibold text-warm-700 mb-2">What should we call your spouse or partner?</label>
                      <input
                        type="text"
                        value={spouseName}
                        onChange={e => setSpouseName(e.target.value)}
                        placeholder="Spouse or partner name"
                        className="w-full border border-warm-200 bg-white rounded-2xl px-4 py-3 text-base text-warm-800 focus:outline-none focus:border-warm-400 transition-colors"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-semibold text-warm-700 mb-2">{spouseName.trim() || 'Spouse'}'s age</label>
                      <div className="flex items-center gap-4">
                        <input type="range" min={18} max={70} value={spouseAge} onChange={e => setSpouseAge(Number(e.target.value))} className="flex-1" />
                        <span className="text-xl font-bold text-warm-700 w-12 text-right font-[family-name:var(--font-display)]">{spouseAge}</span>
                      </div>
                    </div>
                    <div>
                      <label className="block text-sm font-semibold text-warm-700 mb-2">When should {spouseName.trim() || 'your spouse or partner'} retire?</label>
                      <div className="flex items-center gap-4">
                        <input type="range" min={spouseAge + 1} max={80} value={normalizedSpouseRetireAge} onChange={e => setSpouseRetireAge(Number(e.target.value))} className="flex-1" />
                        <span className="text-xl font-bold text-warm-700 w-12 text-right font-[family-name:var(--font-display)]">{normalizedSpouseRetireAge}</span>
                      </div>
                      <p className="text-xs text-warm-400 mt-2">That's {normalizedSpouseRetireAge - spouseAge} years from now</p>
                    </div>
                  </div>
                )}
              </div>
            )}

            {step === 2 && (
              <div className="space-y-4">
                <label className="block text-sm font-semibold text-warm-800 mb-3">Where do you currently live?</label>
                <div className="grid grid-cols-2 gap-2">
                  {Object.entries(COUNTRY_DATA).map(([key, c]) => (
                    <button key={key} onClick={() => setCountry(key)}
                      className={`px-3 py-3 rounded-xl text-sm font-medium transition-all flex items-center gap-2 ${country === key
                        ? 'bg-warm-500 text-white shadow-md shadow-warm-200'
                        : 'bg-cream hover:bg-warm-50 text-warm-700 border border-warm-100'}`}>
                      <span className="text-lg">{c.flag}</span> {c.label}
                    </button>
                  ))}
                </div>
                {country === 'USA' && (
                  <div className="animate-fade-in space-y-3 mt-2">
                    <label className="block text-xs font-semibold text-warm-600">Select your state</label>
                    <div className="grid grid-cols-2 gap-2">
                      {POPULAR_STATES.map(s => (
                        <button key={s} onClick={() => setState(s)}
                          className={`px-3 py-2 rounded-xl text-xs font-medium transition-all ${state === s
                            ? 'bg-warm-500 text-white shadow-md shadow-warm-200'
                            : 'bg-cream hover:bg-warm-50 text-warm-700 border border-warm-100'}`}>
                          {s}
                        </button>
                      ))}
                    </div>
                    <details>
                      <summary className="text-xs text-warm-400 cursor-pointer hover:text-warm-600">More states...</summary>
                      <div className="grid grid-cols-2 gap-2 mt-2 max-h-40 overflow-y-auto">
                        {Object.keys(US_STATE_TAX_RATES).filter(s => !POPULAR_STATES.includes(s)).sort().map(s => (
                          <button key={s} onClick={() => setState(s)}
                            className={`px-2 py-1.5 rounded-xl text-xs font-medium transition-all ${state === s
                              ? 'bg-warm-500 text-white shadow-md shadow-warm-200'
                              : 'bg-cream hover:bg-warm-50 text-warm-700 border border-warm-100'}`}>
                            {s}
                          </button>
                        ))}
                      </div>
                    </details>
                  </div>
                )}
                <p className="text-xs text-warm-400 mt-3 bg-warm-50 p-3 rounded-xl">
                  {country === 'USA' && (() => {
                    const estTax = computeStateTax(myIncome + (hasSpouse ? spouseIncome : 0), state);
                    const estIncome = myIncome + (hasSpouse ? spouseIncome : 0);
                    const effRate = estIncome > 0 ? (estTax / estIncome * 100).toFixed(1) : '0.0';
                    return US_STATE_TAX_RATES[state] === 0
                      ? <>No state income tax in {state}!</>
                      : <>Effective state tax for {state} at your income: <strong className="text-warm-700">{effRate}%</strong></>;
                  })()}
                  {country === 'India' && <>India uses progressive tax slabs (0-30%) + 4% cess. <strong className="text-warm-700">No state income tax.</strong></>}
                  {country === 'Singapore' && <>Singapore has progressive rates up to 24%. <strong className="text-warm-700">No capital gains tax.</strong></>}
                  {country === 'UAE' && <><strong className="text-warm-700">0% personal income tax.</strong> No capital gains tax either.</>}
                </p>
              </div>
            )}

            {step === 1 && (
              <div className="space-y-6">
                <div>
                  <label className="block text-sm font-semibold text-warm-800 mb-2">{possessiveLabel(myName, 'Your')} annual income</label>
                  <div className="flex items-center gap-4">
                    <input type="range" min={0} max={2000000} step={10000} value={myIncome} onChange={e => setMyIncome(Number(e.target.value))} className="flex-1" />
                    <span className="text-lg font-bold text-warm-700 w-20 text-right">{formatCurrency(myIncome)}</span>
                  </div>
                </div>
                {hasSpouse && (
                  <div className="animate-fade-in">
                    <label className="block text-sm font-semibold text-warm-800 mb-2">{possessiveLabel(spouseName, 'Spouse')} annual income</label>
                    <div className="flex items-center gap-4">
                      <input type="range" min={0} max={2000000} step={10000} value={spouseIncome} onChange={e => setSpouseIncome(Number(e.target.value))} className="flex-1" />
                      <span className="text-lg font-bold text-warm-700 w-20 text-right">{formatCurrency(spouseIncome)}</span>
                    </div>
                  </div>
                )}
                {hasSpouse && (
                  <div className="flex justify-between text-sm font-semibold bg-warm-50 p-3 rounded-xl">
                    <span className="text-warm-500">Combined household income</span>
                    <span className="text-warm-800">{formatCurrencyFull(totalIncome)}/yr</span>
                  </div>
                )}
                <div>
                  <label className="block text-sm font-semibold text-warm-800 mb-2">Total savings & investments today</label>
                  <div className="flex items-center gap-4">
                    <input type="range" min={0} max={20000000} step={10000} value={savings} onChange={e => setSavings(Number(e.target.value))} className="flex-1" />
                    <span className="text-lg font-bold text-warm-700 w-20 text-right">{formatCurrency(savings)}</span>
                  </div>
                </div>
              </div>
            )}

            {step === 3 && (
              <div className="text-center space-y-4">
                <div className="bg-sage-50 rounded-2xl p-6 space-y-3">
                  <div className="flex justify-between text-sm">
                    <span className="text-sage-600">{myName || 'Primary planner'}</span>
                    <span className="font-semibold text-sage-800">Age {age}</span>
                  </div>
                  {hasSpouse && (
                    <div className="flex justify-between text-sm">
                      <span className="text-sage-600">{spouseName || 'Spouse / partner'}</span>
                      <span className="font-semibold text-sage-800">Age {spouseAge}</span>
                    </div>
                  )}
                  <div className="flex justify-between text-sm">
                    <span className="text-sage-600">{myName || 'Primary planner'} retires</span>
                    <span className="font-semibold text-sage-800">Age {normalizedPrimaryRetireAge}</span>
                  </div>
                  {hasSpouse && (
                    <div className="flex justify-between text-sm">
                      <span className="text-sage-600">{spouseName || 'Spouse / partner'} retires</span>
                      <span className="font-semibold text-sage-800">Age {normalizedSpouseRetireAge}</span>
                    </div>
                  )}
                  <div className="flex justify-between text-sm">
                    <span className="text-sage-600">Model until</span>
                    <span className="font-semibold text-sage-800">Age {Math.max(modelToAge, finalRetirementAge + 5)}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-sage-600">Location</span>
                    <span className="font-semibold text-sage-800">{COUNTRY_DATA[country].flag} {country === 'USA' ? `${state}, USA` : COUNTRY_DATA[country].label}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-sage-600">{myName || 'Your'} income</span>
                    <span className="font-semibold text-sage-800">{formatCurrencyFull(myIncome)}/yr</span>
                  </div>
                  {hasSpouse && (
                    <div className="flex justify-between text-sm">
                      <span className="text-sage-600">{spouseName || 'Spouse'} income</span>
                      <span className="font-semibold text-sage-800">{formatCurrencyFull(spouseIncome)}/yr</span>
                    </div>
                  )}
                  {hasSpouse && (
                    <div className="flex justify-between text-sm border-t border-sage-200 pt-2">
                      <span className="text-sage-600">Household total</span>
                      <span className="font-bold text-sage-800">{formatCurrencyFull(totalIncome)}/yr</span>
                    </div>
                  )}
                  <div className="flex justify-between text-sm">
                    <span className="text-sage-600">Savings</span>
                    <span className="font-semibold text-sage-800">{formatCurrencyFull(savings)}</span>
                  </div>
                </div>
                <p className="text-xs text-warm-400">You can change all of this later</p>
              </div>
            )}
          </div>

          {/* Navigation */}
          <div className="px-8 pb-8 flex justify-between items-center">
            {canBack ? (
              <button onClick={() => setStep(step - 1)} className="flex items-center gap-1 text-warm-400 hover:text-warm-600 text-sm font-medium transition-colors">
                <ArrowLeft size={16} /> Back
              </button>
            ) : <div />}
            {canNext ? (
              <button onClick={() => setStep(step + 1)} disabled={!stepCanContinue} className="flex items-center gap-1 bg-warm-500 hover:bg-warm-600 disabled:bg-warm-200 disabled:text-white/70 text-white px-6 py-2.5 rounded-xl font-semibold text-sm transition-all shadow-md shadow-warm-200 hover:shadow-lg disabled:shadow-none disabled:cursor-not-allowed">
                Continue <ArrowRight size={16} />
              </button>
            ) : (
              <button onClick={handleComplete} className="flex items-center gap-1 bg-sage-600 hover:bg-sage-700 text-white px-6 py-2.5 rounded-xl font-semibold text-sm transition-all shadow-md shadow-sage-200 hover:shadow-lg">
                <Sparkles size={16} /> See My Forecast
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── MAIN DASHBOARD ─────────────────────────────────────────

function Dashboard({ initialData, onSave, savedState, plans, activePlanId, activePlanName, onOpenPlans, onLoadPlan, onLockVault, onExportEncrypted }) {
  const s = savedState || {}; // restore from saved state if available
  const [planToAge, setPlanToAge] = useState(s.planToAge || initialData.modelToAge || 95);

  // Profile
  const [myName, setMyName] = useState(s.myName || initialData.myName || '');
  const [spouseName, setSpouseName] = useState(s.spouseName || initialData.spouseName || '');
  const [currentAge, setCurrentAge] = useState(s.currentAge || initialData.age);
  const [primaryRetirementAge, setPrimaryRetirementAge] = useState(s.primaryRetirementAge || s.retirementAge || initialData.primaryRetireAge || initialData.retireAge);
  const [location, setLocation] = useState(initialData.state);
  const [locationPhases, setLocationPhases] = useState([
    { id: 1, country: initialData.country || 'USA', state: initialData.state || 'California', startAge: initialData.age, endAge: (initialData.modelToAge || 95) + 1 }
  ]);
  const getLocationAtAge = (age) => locationPhases.find(p => age >= p.startAge && age < p.endAge) || locationPhases[locationPhases.length - 1];
  const [hasSpouse] = useState(initialData.hasSpouse);
  const [spouseAge, setSpouseAge] = useState(s.spouseAge ?? initialData.spouseAge ?? 30);
  const [spouseRetirementAge, setSpouseRetirementAge] = useState(s.spouseRetirementAge || initialData.spouseRetireAge || s.retirementAge || initialData.retireAge || ((initialData.spouseAge || initialData.age) + 25));
  const [myIncome, setMyIncome] = useState(s.myIncome || initialData.myIncome);
  const [spouseIncome, setSpouseIncome] = useState(s.spouseIncome ?? (initialData.spouseIncome || 0));
  const [currentSavings, setCurrentSavings] = useState(s.currentSavings || initialData.savings);
  const [bal401k, setBal401k] = useState(s.bal401k ?? Math.round(initialData.savings * 0.5));
  const [balRoth, setBalRoth] = useState(s.balRoth ?? Math.round(initialData.savings * 0.2));
  const [balTaxable, setBalTaxable] = useState(s.balTaxable ?? Math.round(initialData.savings * 0.3));

  // Tax calculation based on current location phase
  const currentLoc = getLocationAtAge(currentAge);

  // FD Rate for India phases
  const hasIndiaPhase = locationPhases.some(p => p.country === 'India');
  const [fdRate, setFdRate] = useState(7.0);

  const maxAge = planToAge + 1; // exclusive endAge for phases
  const createPhaseId = () => Date.now() + Math.random();

  const updateSequentialPhases = (phases, phaseId, field, rawValue, createContinuation, minStartAge = currentAge) => {
    const index = phases.findIndex(phase => phase.id === phaseId);
    if (index === -1) return phases;

    const updated = phases.map(phase => ({ ...phase }));
    const phase = updated[index];
    const previous = updated[index - 1];
    const next = updated[index + 1];

    if (field === 'startAge') {
      const minValue = previous ? previous.startAge + 1 : minStartAge;
      const nextBoundary = phase.endAge - 1;
      const value = Math.max(minValue, Math.min(Number(rawValue), nextBoundary));
      phase.startAge = value;
      if (previous) previous.endAge = value;
      return updated;
    }

    if (field === 'endAge') {
      const oldEndAge = phase.endAge;
      const value = Math.max(phase.startAge + 1, Math.min(Number(rawValue), maxAge));
      phase.endAge = value;

      if (next) {
        next.startAge = value;
        if (next.endAge <= value) next.endAge = Math.min(maxAge, value + 1);
      } else if (value < oldEndAge) {
        updated.splice(index + 1, 0, createContinuation(phase, value, oldEndAge));
      }

      return updated;
    }

    phase[field] = rawValue;
    return updated;
  };

  const updateLocationPhase = (phaseId, field, value) => {
    setLocationPhases(prev => updateSequentialPhases(
      prev,
      phaseId,
      field,
      value,
      (phase, startAge, endAge) => ({
        id: createPhaseId(),
        country: phase.country,
        state: phase.state,
        startAge,
        endAge,
      }),
      initialData.age,
    ));
  };

  // Expenses
  const [expenses, setExpenses] = useState([
    { id: 1, name: 'Housing', isMedical: false, phases: [{ id: 1, amount: 3000, startAge: initialData.age, endAge: (initialData.modelToAge || 95) + 1 }] },
    { id: 2, name: 'Food & Groceries', isMedical: false, phases: [{ id: 1, amount: 1200, startAge: initialData.age, endAge: (initialData.modelToAge || 95) + 1 }] },
    { id: 3, name: 'Healthcare', isMedical: true, phases: [{ id: 1, amount: 500, startAge: initialData.age, endAge: (initialData.modelToAge || 95) + 1 }] },
    { id: 4, name: 'Transportation', isMedical: false, phases: [{ id: 1, amount: 800, startAge: initialData.age, endAge: (initialData.modelToAge || 95) + 1 }] },
    { id: 5, name: 'Entertainment & Travel', isMedical: false, phases: [{ id: 1, amount: 1000, startAge: initialData.age, endAge: (initialData.modelToAge || 95) + 1 }] },
    { id: 6, name: 'Other', isMedical: false, phases: [{ id: 1, amount: 500, startAge: initialData.age, endAge: (initialData.modelToAge || 95) + 1 }] },
  ]);
  const [expandedExpenses, setExpandedExpenses] = useState({});

  // Kids
  const [kids, setKids] = useState([]);

  // Savings vehicles
  const [my401k, setMy401k] = useState(s.my401k ?? 20000);
  const [spouse401k, setSpouse401k] = useState(s.spouse401k ?? (hasSpouse ? 15000 : 0));
  const [rothIRA, setRothIRA] = useState(s.rothIRA ?? 0);
  const [hsa, setHSA] = useState(s.hsa ?? 0);
  const [plan529, set529] = useState(s.plan529 ?? 0);
  const [otherSavings, setOtherSavings] = useState(s.otherSavings ?? 10000);
  const retirementTimeline = getRetirementAges({
    hasSpouse,
    currentAge,
    spouseAge,
    primaryRetirementAge,
    spouseRetirementAge,
  });
  const firstRetirementAge = retirementTimeline.first;
  const finalRetirementAge = retirementTimeline.final;
  const currentContributionPlan = getContributionPlanForAge({
    age: currentAge,
    hasSpouse,
    myIncome,
    spouseIncome,
    primaryRetirementAge: retirementTimeline.primary,
    spouseRetirementAge: retirementTimeline.spouse,
    my401k,
    spouse401k,
    rothIRA,
    hsa,
    plan529,
    otherSavings,
  });
  const annualContribution = currentContributionPlan.total;
  const taxFreeContribution = currentContributionPlan.taxFree + currentContributionPlan.education;
  const currentEarnedIncome = currentContributionPlan.activeBaseIncome;
  const currentTax = computeCountryTax(currentEarnedIncome, currentLoc.country, currentLoc.state);
  const effectiveTaxRate = currentEarnedIncome > 0 ? (currentTax.total / currentEarnedIncome) * 100 : 0;

  // Social Security
  const [ssClaimAge, setSsClaimAge] = useState(67);
  const baseSSMonthly = estimateSSMonthly(myIncome);
  const adjustedSSMonthly = baseSSMonthly * getSSMultiplier(ssClaimAge);
  const [spouseSsClaimAge, setSpouseSsClaimAge] = useState(67);
  const spouseBaseSSMonthly = estimateSSMonthly(spouseIncome);
  const spouseAdjustedSSMonthly = spouseBaseSSMonthly * getSSMultiplier(spouseSsClaimAge);

  // Market
  const [stockAllocation, setStockAllocation] = useState(60);
  const [inflationRate, setInflationRate] = useState(2.5);
  const [medicalInflation, setMedicalInflation] = useState(4.0);
  const [avgStockReturn, setAvgStockReturn] = useState(7.0);
  const [avgBondReturn, setAvgBondReturn] = useState(3.0);
  const [belowStockReturn, setBelowStockReturn] = useState(5.5);
  const [belowBondReturn, setBelowBondReturn] = useState(2.0);
  const [sigStockReturn, setSigStockReturn] = useState(4.0);
  const [sigBondReturn, setSigBondReturn] = useState(1.0);

  // ─── LIFE EVENTS STATE ────────────────────────────────────
  // Additional income
  const [pensionIncome, setPensionIncome] = useState(s.pensionIncome ?? 0); // annual, starts at pensionStartAge
  const [pensionStartAge, setPensionStartAge] = useState(s.pensionStartAge ?? 65);
  const [rentalIncome, setRentalIncome] = useState(s.rentalIncome ?? 0); // monthly
  const [partTimeIncome, setPartTimeIncome] = useState(s.partTimeIncome ?? 0); // annual, during early retirement
  const [partTimeEndAge, setPartTimeEndAge] = useState(s.partTimeEndAge ?? 65); // stops part-time at this age

  // Healthcare
  const [medicareAge] = useState(65); // Medicare kicks in at 65 (US)
  const [preMedicareCost, setPreMedicareCost] = useState(s.preMedicareCost ?? 1500); // monthly before Medicare
  const [postMedicareCost, setPostMedicareCost] = useState(s.postMedicareCost ?? 400); // monthly after Medicare
  const [longTermCareAge, setLongTermCareAge] = useState(s.longTermCareAge ?? 80);
  const [longTermCareCost, setLongTermCareCost] = useState(s.longTermCareCost ?? 8000); // monthly

  // Housing
  const [homeValue, setHomeValue] = useState(s.homeValue ?? 0);
  const [mortgagePayoffAge, setMortgagePayoffAge] = useState(s.mortgagePayoffAge ?? 55);
  const [downsizeAge, setDownsizeAge] = useState(s.downsizeAge ?? 0); // 0 = no downsize
  const [downsizeEquity, setDownsizeEquity] = useState(s.downsizeEquity ?? 0); // net cash from downsizing

  // Survivor
  const [survivorMode, setSurvivorMode] = useState(s.survivorMode ?? false);
  const [survivorAge, setSurvivorAge] = useState(s.survivorAge ?? 75); // age when spouse passes
  const [lifeInsurance, setLifeInsurance] = useState(s.lifeInsurance ?? 0);

  // UI
  const [activeSection, setActiveSection] = useState('finances');
  const [openSections, setOpenSections] = useState({});
  const [showAllRecommendations, setShowAllRecommendations] = useState(false);
  const [showMonteCarloBands, setShowMonteCarloBands] = useState(false);
  const [showEventMarkers, setShowEventMarkers] = useState(false);
  const [showDetailedAnalysis, setShowDetailedAnalysis] = useState(false);
  const [showHowToUse, setShowHowToUse] = useState(false);
  const toggleSection = (id) => setOpenSections(prev => ({ ...prev, [id]: !prev[id] }));
  const primaryLabel = (myName || '').trim() || 'You';
  const primaryPossessive = possessiveLabel(myName, 'Your');
  const spouseLabel = (spouseName || '').trim() || 'Spouse';
  const spousePossessive = possessiveLabel(spouseName, 'Spouse');
  const retirementSummaryLabel = formatRetirementLabel({
    hasSpouse,
    primaryLabel,
    spouseLabel,
    primaryRetirementAge: retirementTimeline.primary,
    spouseRetirementAge: retirementTimeline.spouse,
  });
  const retirementEvents = [
    { age: retirementTimeline.primary, label: hasSpouse && retirementTimeline.spouse !== retirementTimeline.primary ? `${primaryLabel} retires` : 'Retire' },
    ...(hasSpouse && retirementTimeline.spouse !== retirementTimeline.primary
      ? [{ age: retirementTimeline.spouse, label: `${spouseLabel} retires` }]
      : []),
  ].filter((event, index, list) => list.findIndex(other => other.age === event.age && other.label === event.label) === index);

  useEffect(() => {
    setPrimaryRetirementAge(prev => Math.max(prev, currentAge + 1));
  }, [currentAge]);

  useEffect(() => {
    if (!hasSpouse) return;
    setSpouseRetirementAge(prev => Math.max(prev, spouseAge + 1));
  }, [hasSpouse, spouseAge]);

  useEffect(() => {
    setPlanToAge(prev => Math.max(prev, finalRetirementAge + 5));
  }, [finalRetirementAge]);

  // Computed
  const currentMonthlyExpenses = getTotalExpensesAtAge(expenses, currentAge);
  const retirementMonthlyExpenses = getTotalExpensesAtAge(expenses, finalRetirementAge);
  const netIncome = currentEarnedIncome * (1 - effectiveTaxRate / 100);
  const currentYearlyExpenses = currentMonthlyExpenses * 12;
  const currentYearMilestones = kids.flatMap(kid => getMilestoneYears(kid))
    .filter(e => e.year === currentYear).reduce((sum, e) => sum + e.cost, 0);
  const cashFlowSurplus = netIncome - currentYearlyExpenses - currentYearMilestones - annualContribution;
  const totalMilestoneCost = kids.reduce((sum, kid) => sum + getMilestoneYears(kid).reduce((s, e) => s + e.cost, 0), 0);
  const enabledLifeLevers = [
    pensionIncome > 0,
    rentalIncome > 0,
    partTimeIncome > 0,
    longTermCareCost > 0,
    downsizeAge > 0,
    survivorMode && hasSpouse,
  ].filter(Boolean).length;

  // Expense handlers
  const handleUpdateExpense = (id, field, value) => setExpenses(expenses.map(e => e.id === id ? { ...e, [field]: value } : e));
  const handleAddExpense = () => setExpenses([...expenses, { id: Date.now(), name: 'New Category', isMedical: false, phases: [{ id: Date.now(), amount: 0, startAge: currentAge, endAge: maxAge }] }]);
  const handleRemoveExpense = (id) => setExpenses(expenses.filter(e => e.id !== id));
  const handleUpdatePhase = (expenseId, phaseId, field, value) => setExpenses(prev => prev.map(expense => {
    if (expense.id !== expenseId) return expense;
    return {
      ...expense,
      phases: updateSequentialPhases(
        expense.phases,
        phaseId,
        field,
        value,
        (phase, startAge, endAge) => ({
          ...phase,
          id: createPhaseId(),
          startAge,
          endAge,
        }),
        currentAge,
      )
    };
  }));
  const handleAddPhase = (eid) => setExpenses(expenses.map(e => {
    if (e.id !== eid) return e;
    const lastPhase = e.phases[e.phases.length - 1];
    const midpoint = lastPhase ? Math.floor((lastPhase.startAge + lastPhase.endAge) / 2) : currentAge + 10;
    // Split the last phase: shrink it to midpoint, new phase from midpoint to its old endAge
    const updatedPhases = lastPhase
      ? [...e.phases.slice(0, -1),
         { ...lastPhase, endAge: midpoint },
         { id: Date.now(), amount: 0, startAge: midpoint, endAge: lastPhase.endAge }]
      : [...e.phases, { id: Date.now(), amount: 0, startAge: currentAge, endAge: maxAge }];
    return { ...e, phases: updatedPhases };
  }));
  const handleRemovePhase = (eid, pid) => setExpenses(expenses.map(e => {
    if (e.id !== eid) return e;
    const idx = e.phases.findIndex(p => p.id === pid);
    const removed = e.phases[idx];
    const remaining = e.phases.filter(p => p.id !== pid);
    // Extend the previous phase (or next) to cover the gap
    if (remaining.length > 0 && idx > 0) {
      remaining[idx - 1] = { ...remaining[idx - 1], endAge: removed.endAge };
    } else if (remaining.length > 0) {
      remaining[0] = { ...remaining[0], startAge: removed.startAge };
    }
    return { ...e, phases: remaining };
  }));

  // Simulation — per-account tracking with withdrawal ordering
  const simResults = useMemo(() => {
    const blend = (s, b) => ((stockAllocation / 100) * s) + (((100 - stockAllocation) / 100) * b);
    const blendAvgBond = blend(avgStockReturn, avgBondReturn);
    const blendBelowBond = blend(belowStockReturn, belowBondReturn);
    const blendSigBond = blend(sigStockReturn, sigBondReturn);
    const blendAvgFD = blend(avgStockReturn, fdRate);
    const blendBelowFD = blend(belowStockReturn, fdRate * 0.85);
    const blendSigFD = blend(sigStockReturn, fdRate * 0.7);

    const makeAccounts = () => ({ taxDeferred: bal401k, taxFree: balRoth, education: 0, taxable: balTaxable });
    const accounts = { avg: makeAccounts(), below: makeAccounts(), sig: makeAccounts() };
    let shortfalls = { avg: null, below: null, sig: null };
    const data = [];
    const allMilestones = kids.flatMap(kid => getMilestoneYears(kid));

    const withdrawFrom = (accts, needed, loc) => {
      let remaining = needed;
      let taxPaid = 0;
      // 1. Taxable — ~15% capital gains on 50% gains portion
      if (remaining > 0 && accts.taxable > 0) {
        const amt = Math.min(remaining, accts.taxable); accts.taxable -= amt;
        taxPaid += amt * 0.5 * 0.15; remaining -= amt;
      }
      // 2. Tax-deferred (401k) — ordinary income tax
      if (remaining > 0 && accts.taxDeferred > 0) {
        const amt = Math.min(remaining, accts.taxDeferred); accts.taxDeferred -= amt;
        taxPaid += computeCountryTax(amt, loc.country, loc.state).total; remaining -= amt;
      }
      // 3. Tax-free (Roth/HSA) — no tax
      if (remaining > 0 && accts.taxFree > 0) {
        const amt = Math.min(remaining, accts.taxFree); accts.taxFree -= amt; remaining -= amt;
      }
      // 4. Education (529) — fallback
      if (remaining > 0 && accts.education > 0) {
        const amt = Math.min(remaining, accts.education); accts.education -= amt; remaining -= amt;
      }
      return { taxPaid, unfunded: remaining };
    };

    for (let age = currentAge; age <= planToAge; age++) {
      const workStatus = getWorkStatusAtAge({
        age,
        hasSpouse,
        primaryRetirementAge: retirementTimeline.primary,
        spouseRetirementAge: retirementTimeline.spouse,
      });
      const contributionPlan = getContributionPlanForAge({
        age,
        hasSpouse,
        myIncome,
        spouseIncome,
        primaryRetirementAge: retirementTimeline.primary,
        spouseRetirementAge: retirementTimeline.spouse,
        my401k,
        spouse401k,
        rothIRA,
        hsa,
        plan529,
        otherSavings,
      });
      const loc = getLocationAtAge(age);
      const isIndia = loc.country === 'India';
      const locInf = COUNTRY_DATA[loc.country]?.defaultInflation || inflationRate;
      const locMedInf = COUNTRY_DATA[loc.country]?.defaultMedInflation || medicalInflation;
      const inf = Math.pow(1 + locInf / 100, age - currentAge);
      const medInf = Math.pow(1 + locMedInf / 100, age - currentAge);
      const year = currentYear + (age - currentAge);
      const { medical, nonMedical } = getExpensesByTypeAtAge(expenses, age);

      // Healthcare lifecycle adjustments
      let healthcareAdj = 0;
      if (loc.country === 'USA') {
        if (age < medicareAge) healthcareAdj = preMedicareCost * 12 * medInf;
        else healthcareAdj = postMedicareCost * 12 * medInf;
      }
      if (age >= longTermCareAge) healthcareAdj += longTermCareCost * 12 * medInf;

      const yearlyExp = (nonMedical * 12 * inf) + (medical * 12 * medInf) + healthcareAdj;

      // Housing events
      let housingAdj = 0;
      if (downsizeAge > 0 && age === downsizeAge) housingAdj = -downsizeEquity; // negative = cash inflow

      const milestone = allMilestones.filter(e => e.year === year).reduce((s, e) => s + e.cost * inf, 0);

      // All income sources
      const earnedIncome = (workStatus.primaryWorking ? myIncome * inf : 0) + (workStatus.spouseWorking ? spouseIncome * inf : 0);
      let ssInc = (age >= ssClaimAge ? adjustedSSMonthly * 12 * inf : 0)
        + (hasSpouse && age >= spouseSsClaimAge ? spouseAdjustedSSMonthly * 12 * inf : 0);

      // Survivor mode: after survivorAge, lose spouse's SS but reduce expenses by 30%
      let survivorExpAdj = 1;
      if (survivorMode && hasSpouse && age >= survivorAge) {
        ssInc = (age >= ssClaimAge ? adjustedSSMonthly * 12 * inf : 0); // only your SS
        survivorExpAdj = 0.7; // expenses drop ~30% with one person
      }
      // Life insurance payout at survivor age
      const lifeInsurancePayout = (survivorMode && hasSpouse && age === survivorAge) ? lifeInsurance : 0;

      const pensionInc = (age >= pensionStartAge ? pensionIncome * inf : 0);
      const rentalInc = rentalIncome * 12 * inf;
      const partTimeInc = (workStatus.anyRetired && age < partTimeEndAge ? partTimeIncome * inf : 0);
      const guaranteedIncome = ssInc + pensionInc + rentalInc + partTimeInc;
      const externalIncome = earnedIncome + guaranteedIncome;
      const externalTax = computeCountryTax(externalIncome, loc.country, loc.state).total;
      const oneTimeInflows = lifeInsurancePayout + (housingAdj < 0 ? Math.abs(housingAdj) : 0);
      const adjustedYearlyExp = yearlyExp * survivorExpAdj;
      const contributionCapacity = Math.max(0, externalIncome - externalTax + oneTimeInflows - adjustedYearlyExp - milestone);
      const contributionScale = contributionPlan.total > 0 ? Math.min(1, contributionCapacity / contributionPlan.total) : 0;
      const actualContribTaxDeferred = contributionPlan.taxDeferred * contributionScale;
      const actualContribTaxFree = contributionPlan.taxFree * contributionScale;
      const actualContribEducation = contributionPlan.education * contributionScale;
      const actualContribTaxable = contributionPlan.taxable * contributionScale;
      const actualContribution = actualContribTaxDeferred + actualContribTaxFree + actualContribEducation + actualContribTaxable;
      const cashGap = Math.max(0, adjustedYearlyExp + milestone + actualContribution - (externalIncome - externalTax + oneTimeInflows));

      const scenarios = {
        avg: { pre: avgStockReturn / 100, post: (isIndia ? blendAvgFD : blendAvgBond) / 100 },
        below: { pre: belowStockReturn / 100, post: (isIndia ? blendBelowFD : blendBelowBond) / 100 },
        sig: { pre: sigStockReturn / 100, post: (isIndia ? blendSigFD : blendSigBond) / 100 },
      };

      let taxAvg = 0;
      Object.keys(scenarios).forEach(key => {
        const a = accounts[key];
        const total = a.taxDeferred + a.taxFree + a.education + a.taxable;
        if (total > 0 || workStatus.anyWorking) {
          a.taxDeferred += actualContribTaxDeferred;
          a.taxFree += actualContribTaxFree;
          a.education += actualContribEducation;
          a.taxable += actualContribTaxable;
          if (lifeInsurancePayout > 0) a.taxable += lifeInsurancePayout;
          if (housingAdj < 0) a.taxable += Math.abs(housingAdj);
          let totalTaxPaid = externalTax;
          if (cashGap > 0) {
            const { taxPaid } = withdrawFrom(a, cashGap, loc);
            if (taxPaid > 0) withdrawFrom(a, taxPaid, loc);
            totalTaxPaid += taxPaid;
          }
          if (key === 'avg') taxAvg = totalTaxPaid;
          const r = workStatus.allRetired ? scenarios[key].post : scenarios[key].pre;
          a.taxDeferred = Math.max(0, a.taxDeferred * (1 + r));
          a.taxFree = Math.max(0, a.taxFree * (1 + r));
          a.education = Math.max(0, a.education * (1 + r));
          a.taxable = Math.max(0, a.taxable * (1 + r));
          const newTotal = a.taxDeferred + a.taxFree + a.education + a.taxable;
          if (newTotal <= 0.01 && !shortfalls[key]) { shortfalls[key] = age; a.taxDeferred = 0; a.taxFree = 0; a.education = 0; a.taxable = 0; }
        }
      });

      const sum = (a) => a.taxDeferred + a.taxFree + a.education + a.taxable;
      data.push({
        age,
        year,
        netFlow: (externalIncome - externalTax + oneTimeInflows) - (adjustedYearlyExp + milestone + actualContribution),
        avg: sum(accounts.avg), below: sum(accounts.below), sig: sum(accounts.sig),
        estTax: taxAvg, yearlyExp, country: loc.country,
        earnedIncome,
        guaranteedIncome,
        annualContribution: actualContribution,
        primaryWorking: workStatus.primaryWorking,
        spouseWorking: workStatus.spouseWorking,
        accts: { td: Math.round(accounts.avg.taxDeferred), tf: Math.round(accounts.avg.taxFree), tx: Math.round(accounts.avg.taxable) },
      });
    }
    const sum = (a) => a.taxDeferred + a.taxFree + a.education + a.taxable;
    return { data, shortfalls, finalBalances: { avg: sum(accounts.avg), below: sum(accounts.below), sig: sum(accounts.sig) }, finalAccounts: accounts, blendedAvg: blendAvgBond, blendedBelow: blendBelowBond, blendedSig: blendSigBond };
  }, [bal401k, balRoth, balTaxable, my401k, spouse401k, rothIRA, hsa, plan529, otherSavings, expenses, kids, retirementTimeline.primary, retirementTimeline.spouse, ssClaimAge, adjustedSSMonthly, hasSpouse, spouseSsClaimAge, spouseAdjustedSSMonthly, inflationRate, medicalInflation, stockAllocation, avgStockReturn, avgBondReturn, belowStockReturn, belowBondReturn, sigStockReturn, sigBondReturn, currentAge, locationPhases, fdRate, myIncome, spouseIncome, pensionIncome, pensionStartAge, rentalIncome, partTimeIncome, partTimeEndAge, preMedicareCost, postMedicareCost, longTermCareAge, longTermCareCost, downsizeAge, downsizeEquity, survivorMode, survivorAge, lifeInsurance, medicareAge, planToAge]);

  const { data, shortfalls, finalBalances, finalAccounts, blendedAvg, blendedBelow, blendedSig } = simResults;

  // ─── MONTE CARLO SIMULATION ─────────────────────────────────
  const mcResults = useMemo(() => {
    const RUNS = 500;
    const years = planToAge - currentAge;
    const allMilestones = kids.flatMap(kid => getMilestoneYears(kid));

    // Pseudo-random with seed for reproducibility
    let seed = 42;
    const rand = () => { seed = (seed * 16807 + 0) % 2147483647; return seed / 2147483647; };
    // Box-Muller for normal distribution
    const randNormal = (mean, std) => {
      const u1 = rand(), u2 = rand();
      return mean + std * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    };

    const finalBalances = [];
    const shortfallAges = [];
    const yearlyBalances = Array.from({ length: years + 1 }, () => []);

    for (let run = 0; run < RUNS; run++) {
      let bal = bal401k + balRoth + balTaxable; // simplified pooled for speed
      let depleted = false;
      let shortfallAge = null;

      for (let y = 0; y <= years; y++) {
        const age = currentAge + y;
        const workStatus = getWorkStatusAtAge({
          age,
          hasSpouse,
          primaryRetirementAge: retirementTimeline.primary,
          spouseRetirementAge: retirementTimeline.spouse,
        });
        const contributionPlan = getContributionPlanForAge({
          age,
          hasSpouse,
          myIncome,
          spouseIncome,
          primaryRetirementAge: retirementTimeline.primary,
          spouseRetirementAge: retirementTimeline.spouse,
          my401k,
          spouse401k,
          rothIRA,
          hsa,
          plan529,
          otherSavings,
        });
        const loc = getLocationAtAge(age);
        const isIndia = loc.country === 'India';
        const locInf = COUNTRY_DATA[loc.country]?.defaultInflation || inflationRate;
        const inf = Math.pow(1 + locInf / 100, y);
        const medInf = Math.pow(1 + (COUNTRY_DATA[loc.country]?.defaultMedInflation || medicalInflation) / 100, y);
        const year = currentYear + y;

        const { medical, nonMedical } = getExpensesByTypeAtAge(expenses, age);
        const yearlyExp = (nonMedical * 12 * inf) + (medical * 12 * medInf);
        const milestone = allMilestones.filter(e => e.year === year).reduce((s, e) => s + e.cost * inf, 0);
        const earnedIncome = (workStatus.primaryWorking ? myIncome * inf : 0) + (workStatus.spouseWorking ? spouseIncome * inf : 0);
        const ssIncome = (age >= ssClaimAge ? adjustedSSMonthly * 12 * inf : 0)
          + (hasSpouse && age >= spouseSsClaimAge ? spouseAdjustedSSMonthly * 12 * inf : 0);
        const pensionAtAge = age >= pensionStartAge ? pensionIncome * inf : 0;
        const rentalAtAge = rentalIncome * 12 * inf;
        const partTimeAtAge = workStatus.anyRetired && age < partTimeEndAge ? partTimeIncome * inf : 0;
        const externalIncome = earnedIncome + ssIncome + pensionAtAge + rentalAtAge + partTimeAtAge;
        const externalTax = computeCountryTax(externalIncome, loc.country, loc.state).total;
        const contributionCapacity = Math.max(0, externalIncome - externalTax - yearlyExp - milestone);
        const actualContribution = contributionPlan.total > 0 ? Math.min(contributionPlan.total, contributionCapacity) : 0;
        const cashGap = Math.max(0, yearlyExp + milestone + actualContribution - (externalIncome - externalTax));

        if (!depleted) {
          bal += actualContribution;
          bal -= cashGap;

          // Random annual return: mean = expected, std = 15% for stocks, lower for blended
          const meanReturn = workStatus.allRetired
            ? (isIndia ? (stockAllocation/100 * avgStockReturn + (100-stockAllocation)/100 * fdRate) : blendedAvg)
            : avgStockReturn;
          const stdReturn = workStatus.allRetired ? 8 : 15; // lower variance post-retirement due to bonds
          const annualReturn = randNormal(meanReturn, stdReturn) / 100;
          bal *= (1 + annualReturn);

          if (bal <= 0) { depleted = true; shortfallAge = age; bal = 0; }
        }

        yearlyBalances[y].push(bal);
      }

      finalBalances.push(bal);
      shortfallAges.push(shortfallAge);
    }

    // Compute percentiles
    const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length * p)]; };
    const successCount = shortfallAges.filter(a => a === null).length;

    // Per-year percentiles for chart bands
    const p10 = yearlyBalances.map(yb => pct(yb, 0.10));
    const p25 = yearlyBalances.map(yb => pct(yb, 0.25));
    const p50 = yearlyBalances.map(yb => pct(yb, 0.50));
    const p75 = yearlyBalances.map(yb => pct(yb, 0.75));
    const p90 = yearlyBalances.map(yb => pct(yb, 0.90));

    return {
      successRate: Math.round(successCount / RUNS * 100),
      medianFinal: pct(finalBalances, 0.5),
      p10Final: pct(finalBalances, 0.1),
      p90Final: pct(finalBalances, 0.9),
      worstFinal: pct(finalBalances, 0.05),
      bestFinal: pct(finalBalances, 0.95),
      medianShortfall: shortfallAges.filter(a => a !== null).length > 0
        ? Math.round(shortfallAges.filter(a => a !== null).reduce((s, a) => s + a, 0) / shortfallAges.filter(a => a !== null).length)
        : null,
      bands: { p10, p25, p50, p75, p90 },
    };
  }, [bal401k, balRoth, balTaxable, expenses, kids, retirementTimeline.primary, retirementTimeline.spouse, ssClaimAge, adjustedSSMonthly, hasSpouse, spouseSsClaimAge, spouseAdjustedSSMonthly, inflationRate, medicalInflation, stockAllocation, avgStockReturn, fdRate, blendedAvg, currentAge, planToAge, locationPhases, myIncome, spouseIncome, my401k, spouse401k, rothIRA, hsa, plan529, otherSavings, pensionIncome, pensionStartAge, rentalIncome, partTimeIncome, partTimeEndAge]);

  // ─── RECOMMENDATIONS ENGINE ─────────────────────────────────
  const recommendations = useMemo(() => {
    const recs = [];
    const moderateShortfall = shortfalls.below;
    const conservativeShortfall = shortfalls.sig;
    const yearsToRetire = Math.max(1, finalRetirementAge - currentAge);
    const retireExpenses = data.find(d => d.age === finalRetirementAge)?.yearlyExp || 0;
    const finalAvg = finalBalances.avg;
    const latestRetireeLabel = hasSpouse && retirementTimeline.spouse > retirementTimeline.primary ? spouseLabel : primaryLabel;

    // 1. Required additional savings to fix moderate shortfall
    if (moderateShortfall) {
      const yearsShort = planToAge - moderateShortfall;
      const additionalNeeded = Math.round(yearsShort * retireExpenses * 0.6 / yearsToRetire); // rough
      recs.push({
        type: 'save',
        severity: 'warning',
        title: 'Increase savings',
        detail: `Save an additional ${formatCurrencyFull(additionalNeeded)}/yr to extend your moderate scenario past age ${planToAge}.`,
      });
    }

    // 2. Latest safe retirement age (where moderate scenario doesn't run out)
    let safeRetireAge = finalRetirementAge;
    for (let tryAge = finalRetirementAge; tryAge <= 75; tryAge++) {
      const retireData = data.find(d => d.age === planToAge);
      if (retireData && retireData.below > 0) break;
      safeRetireAge = tryAge + 1;
    }
    if (safeRetireAge > finalRetirementAge && moderateShortfall) {
      // Binary search for safe age by checking when "below" scenario at planToAge > 0
      // Simplified: estimate based on shortfall
      const extraYearsNeeded = Math.ceil((moderateShortfall ? planToAge - moderateShortfall : 0) / 3);
      const suggestedAge = Math.min(finalRetirementAge + extraYearsNeeded, 70);
      if (suggestedAge > finalRetirementAge) {
        recs.push({
          type: 'delay',
          severity: 'info',
          title: 'Consider delaying retirement',
          detail: hasSpouse && retirementTimeline.primary !== retirementTimeline.spouse
            ? `Keeping ${latestRetireeLabel} working until age ${suggestedAge} instead of ${finalRetirementAge} would add ~${suggestedAge - finalRetirementAge} more years of income and contributions.`
            : `Retiring at age ${suggestedAge} instead of ${finalRetirementAge} would add ~${suggestedAge - finalRetirementAge} more years of contributions and growth.`,
        });
      }
    }

    // 3. Sustainable monthly spend (4% rule on optimistic final balance at retirement)
    const retireBalance = data.find(d => d.age === finalRetirementAge)?.avg || 0;
    const sustainableAnnual = retireBalance * 0.04;
    const sustainableMonthly = Math.round(sustainableAnnual / 12);
    const currentMonthlyAtRetire = Math.round(retireExpenses / 12);
    if (sustainableMonthly > 0) {
      recs.push({
        type: 'spend',
        severity: sustainableMonthly >= currentMonthlyAtRetire ? 'success' : 'warning',
        title: 'Sustainable spend',
        detail: `At retirement, the 4% rule suggests ${formatCurrencyFull(sustainableAnnual)}/yr (${formatCurrency(sustainableMonthly)}/mo). ${
          sustainableMonthly >= currentMonthlyAtRetire
            ? 'Your planned expenses are within this.'
            : `Your planned ${formatCurrency(currentMonthlyAtRetire)}/mo exceeds this by ${formatCurrency(currentMonthlyAtRetire - sustainableMonthly)}/mo.`
        }`,
      });
    }

    // 4. Roth advantage
    if (rothIRA === 0 && balRoth === 0 && bal401k > 0) {
      recs.push({
        type: 'roth',
        severity: 'info',
        title: 'Consider Roth contributions',
        detail: 'You have no Roth savings. Roth withdrawals are tax-free in retirement, reducing your tax burden and extending your portfolio.',
      });
    }

    // 5. Tax-free percentage
    const tfPct = annualContribution > 0 ? (taxFreeContribution / annualContribution * 100) : 0;
    if (tfPct < 20 && annualContribution > 0) {
      recs.push({
        type: 'tax',
        severity: 'info',
        title: 'Low tax-free allocation',
        detail: `Only ${tfPct.toFixed(0)}% of your savings goes to tax-free accounts. Increasing Roth/HSA contributions reduces future tax drag.`,
      });
    }

    // 6. On track message
    if (!moderateShortfall && !conservativeShortfall) {
      recs.push({
        type: 'success',
        severity: 'success',
        title: 'You\'re on track!',
        detail: 'All three scenarios show funds lasting through your planning horizon. Keep it up.',
      });
    }

    return recs;
  }, [shortfalls, finalBalances, data, finalRetirementAge, currentAge, planToAge, rothIRA, balRoth, bal401k, annualContribution, taxFreeContribution, hasSpouse, retirementTimeline.primary, retirementTimeline.spouse, primaryLabel, spouseLabel]);

  const visibleRecommendations = showAllRecommendations ? recommendations : recommendations.slice(0, 2);
  const hiddenRecommendationCount = Math.max(0, recommendations.length - visibleRecommendations.length);

  // Chart
  const chartH = 320, chartW = 800;
  const pad = { top: 38, right: 20, bottom: 40, left: 70 };
  const iW = chartW - pad.left - pad.right, iH = chartH - pad.top - pad.bottom;
  const maxBal = Math.min(Math.max(...data.map(d => d.avg), 100000), 150000000);
  const gX = (a) => pad.left + ((a - currentAge) / (planToAge - currentAge)) * iW;
  const gY = (v) => pad.top + iH - (Math.min(v, maxBal * 1.2) / maxBal) * iH;
  const gP = (k) => data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${gX(d.age)} ${gY(d[k])}`).join(' ');

  // Serialize all state for save/load
  const getState = useCallback(() => ({
    myName, spouseName,
    planToAge, currentAge, retirementAge: retirementTimeline.primary, primaryRetirementAge: retirementTimeline.primary, spouseRetirementAge: retirementTimeline.spouse, myIncome, spouseIncome, currentSavings,
    bal401k, balRoth, balTaxable, my401k, spouse401k, rothIRA, hsa, plan529, otherSavings,
    ssClaimAge, spouseSsClaimAge, stockAllocation, inflationRate, medicalInflation,
    avgStockReturn, avgBondReturn, belowStockReturn, belowBondReturn, sigStockReturn, sigBondReturn,
    fdRate, expenses, kids, locationPhases, hasSpouse, spouseAge,
    pensionIncome, pensionStartAge, rentalIncome, partTimeIncome, partTimeEndAge,
    preMedicareCost, postMedicareCost, longTermCareAge, longTermCareCost,
    homeValue, mortgagePayoffAge, downsizeAge, downsizeEquity,
    survivorMode, survivorAge, lifeInsurance,
  }), [myName, spouseName, planToAge, currentAge, retirementTimeline.primary, retirementTimeline.spouse, myIncome, spouseIncome, currentSavings,
    bal401k, balRoth, balTaxable, my401k, spouse401k, rothIRA, hsa, plan529, otherSavings,
    ssClaimAge, spouseSsClaimAge, stockAllocation, inflationRate, medicalInflation,
    avgStockReturn, avgBondReturn, belowStockReturn, belowBondReturn, sigStockReturn, sigBondReturn,
    fdRate, expenses, kids, locationPhases, hasSpouse, spouseAge,
    pensionIncome, pensionStartAge, rentalIncome, partTimeIncome, partTimeEndAge,
    preMedicareCost, postMedicareCost, longTermCareAge, longTermCareCost,
    homeValue, mortgagePayoffAge, downsizeAge, downsizeEquity,
    survivorMode, survivorAge, lifeInsurance]);

  // Auto-save on state change
  useEffect(() => {
    if (onSave) onSave(getState());
  }, [getState, onSave]);

  const handleExportJSON = () => {
    onExportEncrypted?.({
      id: activePlanId || Date.now(),
      name: activePlanName,
      initialData,
      state: getState(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  };

  const tabs = [
    { id: 'finances', label: 'Your Finances', icon: Wallet },
    { id: 'market', label: 'Market', icon: TrendingUp },
  ];

  return (
    <div className="min-h-screen bg-cream">
      <HelpModal open={showHowToUse} onClose={() => setShowHowToUse(false)} />
      {/* Header */}
      <header className="bg-white/80 backdrop-blur-md border-b border-warm-100/50 sticky top-0 z-20">
        <div className="max-w-[1600px] mx-auto px-4 md:px-8 py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 bg-gradient-to-br from-warm-400 to-warm-600 rounded-xl flex items-center justify-center shadow-sm shadow-warm-200/50">
              <Sun size={16} className="text-white" />
            </div>
            <div>
              <h1 className="text-lg md:text-xl font-bold text-warm-900 font-[family-name:var(--font-display)]">Retirement Planner</h1>
              <p className="text-[11px] text-warm-400 mt-0.5">{activePlanName} · {hasSpouse ? `${primaryLabel} and ${spouseLabel}` : primaryLabel}</p>
            </div>
            <button onClick={onOpenPlans} className="text-xs text-warm-500 hover:text-warm-700 flex items-center gap-1.5 bg-warm-50 px-3 py-1.5 rounded-xl border border-warm-100/70 transition-colors motion-button" title="Open plans page">
              <FolderOpen size={11} /> Plans
            </button>
            <button onClick={() => setShowHowToUse(true)} className="text-xs text-warm-500 hover:text-warm-700 flex items-center gap-1.5 bg-warm-50 px-3 py-1.5 rounded-xl border border-warm-100/70 transition-colors motion-button" title="Learn how the planner works">
              <FileText size={11} /> How to Use
            </button>
            <button onClick={handleExportJSON} className="text-xs text-warm-500 hover:text-warm-700 flex items-center gap-1.5 bg-warm-50 px-3 py-1.5 rounded-xl border border-warm-100/70 transition-colors motion-button" title="Download encrypted backup">
              <Download size={11} /> Backup
            </button>
            <button onClick={onLockVault} className="text-xs text-warm-500 hover:text-warm-700 flex items-center gap-1.5 bg-warm-50 px-3 py-1.5 rounded-xl border border-warm-100/70 transition-colors motion-button" title="Lock this device vault">
              <Lock size={11} /> Lock
            </button>
          </div>
          <div className="flex items-center gap-2 text-xs shrink-0">
            {currentYearMilestones > 0 && (
              <div className="hidden md:flex items-center gap-1.5 rounded-full bg-sky-light px-3.5 py-2 font-semibold text-sky">
                <Calendar size={12} />
                {formatCurrency(currentYearMilestones)} milestones this year
              </div>
            )}
            <div className={`font-bold px-4 py-2 rounded-full text-sm tracking-tight shadow-sm ${cashFlowSurplus >= 0 ? 'bg-sage-50 text-sage-700' : 'bg-coral-light text-coral'}`}>
              Annual cash flow {cashFlowSurplus >= 0 ? '+' : ''}{formatCurrency(cashFlowSurplus)}
            </div>
          </div>
        </div>
      </header>

      <div className="max-w-[1600px] mx-auto px-4 md:px-8 py-5 space-y-5">
        <div className="bg-white rounded-[28px] shadow-sm border border-warm-100/30 p-6 md:p-7">
          <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-5 mb-5">
            <div className="max-w-2xl">
              <h2 className="text-2xl md:text-3xl text-warm-900 font-[family-name:var(--font-display)]">{primaryPossessive} Financial Journey</h2>
              <p className="text-sm md:text-[15px] text-warm-500 mt-2 leading-relaxed">Focus on the main trajectory first, then layer in uncertainty and life-event markers as needed.</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => setShowMonteCarloBands(v => !v)}
                className={`px-4 py-2 rounded-full text-[11px] font-semibold tracking-wide transition-colors motion-button ${showMonteCarloBands ? 'bg-warm-100 text-warm-700' : 'bg-warm-50 text-warm-400 hover:text-warm-600'}`}
              >
                Monte Carlo bands
              </button>
              <button
                onClick={() => setShowEventMarkers(v => !v)}
                className={`px-4 py-2 rounded-full text-[11px] font-semibold tracking-wide transition-colors motion-button ${showEventMarkers ? 'bg-warm-100 text-warm-700' : 'bg-warm-50 text-warm-400 hover:text-warm-600'}`}
              >
                Event markers
              </button>
            </div>
          </div>

          <div className="flex flex-wrap gap-x-4 gap-y-2 text-[11px] font-semibold text-warm-500 mb-4">
            <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-sage-500" />Optimistic</span>
            <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-warm-400" />Moderate</span>
            <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-coral" />Conservative</span>
            {showMonteCarloBands && <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-warm-200/50" />MC bands</span>}
            {showEventMarkers && <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-sky" />Events</span>}
          </div>

          <svg viewBox={`0 0 ${chartW} ${chartH}`} className="w-full h-auto">
              {[0, 0.25, 0.5, 0.75, 1].map((r, i) => {
                const y = pad.top + iH * (1 - r);
                return (<g key={i}><line x1={pad.left} y1={y} x2={chartW - pad.right} y2={y} stroke="#DDD3C6" strokeWidth={1} />
                  <text x={pad.left - 8} y={y + 4} textAnchor="end" fill="#6B5E52" fontSize="10" fontFamily="IBM Plex Sans">
                    {maxBal * r >= 1e6 ? `$${(maxBal*r/1e6).toFixed(1)}M` : `$${Math.round(maxBal*r/1000)}K`}
                  </text></g>);
              })}
              {data.filter((_, i) => i % 10 === 0 || i === data.length - 1).map((d, i) => (
                <text key={i} x={gX(d.age)} y={chartH - 12} textAnchor="middle" fill="#6B5E52" fontSize="10" fontFamily="IBM Plex Sans">{d.age}</text>
              ))}
              {retirementEvents.map((event, index) => (
                <g key={`${event.label}-${event.age}`}>
                  <line x1={gX(event.age)} y1={pad.top} x2={gX(event.age)} y2={chartH - pad.bottom} stroke={index === 0 ? '#7B461F' : '#B66A2B'} strokeWidth="1" strokeDasharray="4 4" opacity="0.55" />
                  <text x={gX(event.age)} y={Math.max(14, pad.top - (index * 12) - 8)} fill={index === 0 ? '#7B461F' : '#B66A2B'} fontSize="9" fontWeight="600" textAnchor="middle" fontFamily="IBM Plex Sans">{event.label}</text>
                </g>
              ))}
              {showMonteCarloBands && mcResults.bands.p10.length > 0 && (() => {
                const bandPath = (upper, lower) => {
                  const fwd = upper.map((v, i) => `${i === 0 ? 'M' : 'L'} ${gX(currentAge + i)} ${gY(Math.max(0, v))}`).join(' ');
                  const bwd = [...lower].reverse().map((v, i) => `L ${gX(currentAge + lower.length - 1 - i)} ${gY(Math.max(0, v))}`).join(' ');
                  return fwd + ' ' + bwd + ' Z';
                };
                return (
                  <>
                    <path d={bandPath(mcResults.bands.p90, mcResults.bands.p10)} fill="#9A6635" opacity="0.08" />
                    <path d={bandPath(mcResults.bands.p75, mcResults.bands.p25)} fill="#9A6635" opacity="0.12" />
                    <path d={mcResults.bands.p50.map((v, i) => `${i === 0 ? 'M' : 'L'} ${gX(currentAge + i)} ${gY(Math.max(0, v))}`).join(' ')} fill="none" stroke="#6B5E52" strokeWidth="1" strokeDasharray="2 3" opacity="0.6" />
                  </>
                );
              })()}
              <path d={gP('avg')} fill="none" stroke="#36503C" strokeWidth="2.5" strokeLinecap="round" />
              <path d={gP('below')} fill="none" stroke="#7B461F" strokeWidth="2" strokeDasharray="6 4" strokeLinecap="round" />
              <path d={gP('sig')} fill="none" stroke="#A84D3A" strokeWidth="1.5" strokeDasharray="3 3" strokeLinecap="round" />

              {showEventMarkers && ssClaimAge > currentAge && ssClaimAge <= planToAge && !retirementEvents.some(event => event.age === ssClaimAge) && (
                <g>
                  <line x1={gX(ssClaimAge)} y1={pad.top} x2={gX(ssClaimAge)} y2={chartH - pad.bottom} stroke="#2E6F8E" strokeWidth="1" strokeDasharray="3 3" opacity="0.6" />
                  <text x={gX(ssClaimAge)} y={chartH - pad.bottom + 12} fill="#2E6F8E" fontSize="8" fontWeight="600" textAnchor="middle">SS {ssClaimAge}</text>
                </g>
              )}
              {showEventMarkers && medicareAge >= currentAge && medicareAge <= planToAge && !retirementEvents.some(event => event.age === medicareAge) && (
                <g>
                  <line x1={gX(medicareAge)} y1={pad.top + 20} x2={gX(medicareAge)} y2={chartH - pad.bottom} stroke="#36503C" strokeWidth="1" strokeDasharray="2 4" opacity="0.45" />
                  <text x={gX(medicareAge)} y={pad.top + 16} fill="#36503C" fontSize="7" textAnchor="middle">Medicare</text>
                </g>
              )}
              {showEventMarkers && longTermCareCost > 0 && longTermCareAge <= planToAge && (
                <g>
                  <line x1={gX(longTermCareAge)} y1={pad.top + 20} x2={gX(longTermCareAge)} y2={chartH - pad.bottom} stroke="#A84D3A" strokeWidth="1" strokeDasharray="2 4" opacity="0.45" />
                  <text x={gX(longTermCareAge)} y={pad.top + 16} fill="#A84D3A" fontSize="7" textAnchor="middle">LTC</text>
                </g>
              )}
              {showEventMarkers && shortfalls.avg && (
                <g>
                  <circle cx={gX(shortfalls.avg)} cy={gY(0)} r="4" fill="#36503C" stroke="white" strokeWidth="1.5" />
                  <text x={gX(shortfalls.avg)} y={gY(0) - 8} fill="#36503C" fontSize="7" fontWeight="700" textAnchor="middle">Depleted</text>
                </g>
              )}
              {showEventMarkers && shortfalls.below && shortfalls.below !== shortfalls.avg && (
                <circle cx={gX(shortfalls.below)} cy={gY(0)} r="3" fill="#7B461F" stroke="white" strokeWidth="1" />
              )}
              {showEventMarkers && shortfalls.sig && shortfalls.sig !== shortfalls.below && (
                <circle cx={gX(shortfalls.sig)} cy={gY(0)} r="3" fill="#A84D3A" stroke="white" strokeWidth="1" />
              )}
              {showEventMarkers && downsizeAge > 0 && downsizeAge <= planToAge && (
                <g>
                  <rect x={gX(downsizeAge) - 2} y={pad.top + 24} width="4" height="4" fill="#6D5A47" rx="1" />
                  <text x={gX(downsizeAge)} y={pad.top + 38} fill="#6D5A47" fontSize="7" textAnchor="middle">Sell</text>
                </g>
              )}
              {showEventMarkers && survivorMode && hasSpouse && survivorAge <= planToAge && (
                <g>
                  <line x1={gX(survivorAge)} y1={pad.top + 20} x2={gX(survivorAge)} y2={chartH - pad.bottom} stroke="#A84D3A" strokeWidth="1" strokeDasharray="1 3" opacity="0.35" />
                  <text x={gX(survivorAge)} y={pad.top + 16} fill="#A84D3A" fontSize="7" textAnchor="middle">Survivor</text>
                </g>
              )}
          </svg>
        </div>

        <DashboardPlanComparison plans={plans} activePlanId={activePlanId} onLoadPlan={onLoadPlan} onOpenPlans={onOpenPlans} />

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-6 gap-4">
          <ScenarioCard title="Optimistic" balance={finalBalances.avg} shortfallAge={shortfalls.avg} color="sage" accounts={finalAccounts?.avg} />
          <ScenarioCard title="Moderate" balance={finalBalances.below} shortfallAge={shortfalls.below} color="warm" accounts={finalAccounts?.below} />
          <ScenarioCard title="Conservative" balance={finalBalances.sig} shortfallAge={shortfalls.sig} color="coral" accounts={finalAccounts?.sig} />

          <div className={`p-5 rounded-[24px] border ${mcResults.successRate >= 80 ? 'border-sage-200 bg-sage-50' : mcResults.successRate >= 50 ? 'border-warm-200 bg-warm-50' : 'border-coral bg-coral-light'} flex flex-col`}>
            <span className="text-[10px] font-bold uppercase tracking-wider text-warm-400">500 Simulations</span>
            <div className="mt-3 flex items-baseline gap-1">
              <span className={`text-3xl font-black font-[family-name:var(--font-display)] ${mcResults.successRate >= 80 ? 'text-sage-700' : mcResults.successRate >= 50 ? 'text-warm-700' : 'text-coral'}`}>
                {mcResults.successRate}%
              </span>
              <span className="text-xs text-warm-400">success rate</span>
            </div>
            <div className="mt-3 space-y-1 text-[11px] text-warm-400 leading-relaxed">
              <div className="flex justify-between"><span>Median final</span><span className="text-warm-600">{formatCurrencyFull(mcResults.medianFinal)}</span></div>
              <div className="flex justify-between"><span>10th pctile</span><span className="text-coral">{formatCurrencyFull(Math.max(0, mcResults.p10Final))}</span></div>
              <div className="flex justify-between"><span>90th pctile</span><span className="text-sage-600">{formatCurrencyFull(mcResults.p90Final)}</span></div>
              {mcResults.medianShortfall && <div className="flex justify-between"><span>Median depletion</span><span className="text-coral">Age {mcResults.medianShortfall}</span></div>}
            </div>
          </div>

          {recommendations.length > 0 && (
            <div className="xl:col-span-2 p-5 rounded-[24px] border border-warm-100 bg-white flex flex-col shadow-sm shadow-warm-100/20 surface-hover">
              <div className="flex items-center justify-between gap-3 mb-4">
                <div>
                  <h3 className="text-base font-semibold text-warm-800">Top insights</h3>
                  <p className="text-sm text-warm-400 leading-relaxed">Showing the highest-signal suggestions first.</p>
                </div>
                {recommendations.length > 2 && (
                  <button onClick={() => setShowAllRecommendations(v => !v)} className="text-xs font-semibold text-warm-500 hover:text-warm-700 whitespace-nowrap">
                    {showAllRecommendations ? 'Show fewer' : `Show all ${recommendations.length}`}
                  </button>
                )}
              </div>
              <div className="space-y-3">
                {visibleRecommendations.map((rec, i) => (
                  <div key={i} className={`p-4 rounded-2xl border text-sm ${
                    rec.severity === 'success' ? 'bg-sage-50 border-sage-200' :
                    rec.severity === 'warning' ? 'bg-warm-50 border-warm-200' :
                    'bg-sky-light border-sky/20'
                  }`}>
                    <div className={`font-semibold mb-1 ${
                      rec.severity === 'success' ? 'text-sage-700' :
                      rec.severity === 'warning' ? 'text-warm-700' :
                      'text-sky'
                    }`}>
                      {rec.severity === 'success' && <CheckCircle2 size={11} className="inline mr-1 -mt-0.5" />}
                      {rec.severity === 'warning' && <AlertTriangle size={11} className="inline mr-1 -mt-0.5" />}
                      {rec.severity === 'info' && <Sparkles size={11} className="inline mr-1 -mt-0.5" />}
                      {rec.title}
                    </div>
                    <p className="text-warm-500 leading-relaxed text-[13px]">{rec.detail}</p>
                  </div>
                ))}
              </div>
              {!showAllRecommendations && hiddenRecommendationCount > 0 && (
                <div className="mt-3 text-xs text-warm-400">{hiddenRecommendationCount} more recommendation{hiddenRecommendationCount === 1 ? '' : 's'} hidden.</div>
              )}
            </div>
          )}
        </div>

        <div className="bg-white rounded-[28px] shadow-sm border border-warm-100/30 overflow-hidden flex flex-col animate-fade-in-up">
          <div className="flex border-b border-warm-100/50 bg-warm-50/30 px-3 pt-3 gap-2">
            {tabs.map(tab => (
              <TabButton key={tab.id} id={tab.id} label={tab.label} icon={tab.icon} active={activeSection === tab.id} set={setActiveSection} />
            ))}
          </div>

          <div className="p-6 flex-1 overflow-y-auto max-h-[720px]">
            {activeSection === 'finances' && (
              <div className="space-y-4 animate-fade-in">
                <CollapsibleSection
                  title="Age & Retirement"
                  summary={hasSpouse ? `${primaryLabel} ${retirementTimeline.primary} · ${spouseLabel} ${retirementTimeline.spouse}` : `${primaryLabel} retires at ${retirementTimeline.primary}`}
                  isOpen={!!openSections.age}
                  onToggle={() => toggleSection('age')}
                >
                  <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
                    <div className="space-y-4">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <input type="text" value={myName} onChange={e => setMyName(e.target.value)} placeholder="Primary planner name" className="w-full border border-warm-200 bg-cream/60 rounded-2xl px-4 py-3 text-base text-warm-800 focus:outline-none focus:border-warm-400 focus:bg-white transition-colors" />
                        {hasSpouse && <input type="text" value={spouseName} onChange={e => setSpouseName(e.target.value)} placeholder="Spouse or partner name" className="w-full border border-warm-200 bg-cream/60 rounded-2xl px-4 py-3 text-base text-warm-800 focus:outline-none focus:border-warm-400 focus:bg-white transition-colors" />}
                      </div>
                      <Slider label={`${primaryPossessive} Age`} value={currentAge} set={setCurrentAge} min={18} max={70} format={v => `${v}`} />
                      {hasSpouse && <Slider label={`${spousePossessive} Age`} value={spouseAge} set={setSpouseAge} min={18} max={70} format={v => `${v}`} />}
                      <Slider label={`${primaryLabel} Retires`} value={retirementTimeline.primary} set={setPrimaryRetirementAge} min={currentAge + 1} max={80} format={v => `Age ${v}`} />
                      {hasSpouse && <Slider label={`${spouseLabel} Retires`} value={retirementTimeline.spouse} set={setSpouseRetirementAge} min={spouseAge + 1} max={80} format={v => `Age ${v}`} />}
                      <Slider label="Plan Until" value={planToAge} set={setPlanToAge} min={finalRetirementAge + 5} max={110} format={v => `Age ${v}`} />
                    </div>
                    <div className="space-y-4">
                      <Slider label="Total Savings" value={currentSavings} set={setCurrentSavings} min={0} max={20000000} step={10000} format={formatCurrencyFull} />
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <div className="rounded-xl border border-warm-100 bg-warm-50/50 p-3 text-xs">
                          <div className="text-warm-400 uppercase tracking-wider font-semibold mb-1">Timeline</div>
                          <div className="text-warm-700 font-semibold">{retirementSummaryLabel}</div>
                          <div className="text-warm-400 mt-1">First retirement in {Math.max(0, firstRetirementAge - currentAge)} years</div>
                          {hasSpouse && retirementTimeline.primary !== retirementTimeline.spouse && <div className="text-warm-400 mt-1">Fully retired in {Math.max(0, finalRetirementAge - currentAge)} years</div>}
                          <div className="text-warm-400 mt-1">Planning horizon through age {planToAge}</div>
                        </div>
                        <div className="rounded-xl border border-warm-100 bg-warm-50/50 p-3 text-xs">
                          <div className="text-warm-400 uppercase tracking-wider font-semibold mb-1">Today</div>
                          <div className="text-warm-700 font-semibold">{formatCurrencyFull(currentSavings)} invested</div>
                          <div className="text-warm-400 mt-1">Across taxable, tax-deferred, and tax-free accounts</div>
                        </div>
                      </div>
                    </div>
                  </div>
                </CollapsibleSection>

                <CollapsibleSection
                  title="Income & Taxes"
                  summary={`Net ${formatCurrency(netIncome)}/yr at ${effectiveTaxRate.toFixed(1)}% effective tax`}
                  isOpen={!!openSections.income}
                  onToggle={() => toggleSection('income')}
                >
                  <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
                    <div className="space-y-4">
                      <Slider label={`${primaryPossessive} Income`} value={myIncome} set={setMyIncome} min={0} max={2000000} step={10000} format={formatCurrencyFull} />
                      {hasSpouse && <Slider label={`${spousePossessive} Income`} value={spouseIncome} set={setSpouseIncome} min={0} max={2000000} step={10000} format={formatCurrencyFull} />}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <div className="flex justify-between text-xs font-semibold bg-warm-50 p-3 rounded-xl border border-warm-100">
                          <span className="text-warm-400">Gross household income</span>
                          <span className="text-warm-700">{formatCurrencyFull(currentEarnedIncome)}/yr</span>
                        </div>
                        <div className="flex justify-between text-xs font-semibold bg-warm-50 p-3 rounded-xl border border-warm-100">
                          <span className="text-warm-400">Net income</span>
                          <span className="text-warm-700">{formatCurrencyFull(netIncome)}/yr</span>
                        </div>
                      </div>
                    </div>

                    <div className="space-y-4">
                      <div className="flex justify-between items-center">
                        <h3 className="text-[10px] font-bold text-warm-400 uppercase tracking-wider">Location Phases</h3>
                        <button onClick={() => {
                          const last = locationPhases[locationPhases.length - 1];
                          const mid = Math.floor((last.startAge + last.endAge) / 2);
                          setLocationPhases([
                            ...locationPhases.slice(0, -1),
                            { ...last, endAge: mid },
                            { id: Date.now(), country: 'USA', state: 'California', startAge: mid, endAge: last.endAge }
                          ]);
                        }} className="text-[10px] text-warm-500 hover:text-warm-700 font-semibold flex items-center gap-0.5">
                          <Plus size={10} /> Phase
                        </button>
                      </div>
                      {locationPhases.map((lp, idx) => (
                        <div key={lp.id} className="bg-cream rounded-lg p-2.5 space-y-1.5 border border-warm-100 text-xs">
                          <div className="flex items-center gap-1.5">
                            <select value={lp.country} onChange={e => {
                              const c = e.target.value;
                              setLocationPhases(locationPhases.map(p => p.id === lp.id ? { ...p, country: c, state: c === 'USA' ? 'California' : null } : p));
                            }} className="bg-white border border-warm-200 rounded-lg px-1.5 py-1 text-xs focus:outline-none focus:border-warm-400">
                              {Object.entries(COUNTRY_DATA).map(([k, v]) => <option key={k} value={k}>{v.flag} {v.label}</option>)}
                            </select>
                            {lp.country === 'USA' && (
                              <select value={lp.state || 'California'} onChange={e => setLocationPhases(locationPhases.map(p => p.id === lp.id ? { ...p, state: e.target.value } : p))}
                                className="bg-white border border-warm-200 rounded-lg px-1.5 py-1 text-xs focus:outline-none focus:border-warm-400 flex-1">
                                {Object.keys(US_STATE_TAX_RATES).sort().map(s => <option key={s} value={s}>{s}</option>)}
                              </select>
                            )}
                            {locationPhases.length > 1 && (
                              <button onClick={() => {
                                const rem = locationPhases[idx];
                                const remaining = locationPhases.filter(p => p.id !== lp.id);
                                if (idx > 0) remaining[idx - 1] = { ...remaining[idx - 1], endAge: rem.endAge };
                                else if (remaining.length) remaining[0] = { ...remaining[0], startAge: rem.startAge };
                                setLocationPhases(remaining);
                              }} className="text-warm-200 hover:text-coral"><Trash2 size={11} /></button>
                            )}
                          </div>
                          <div className="flex items-center gap-1 text-warm-400">
                            <span>Age</span>
                            <NumberCommitInput value={lp.startAge} onCommit={value => updateLocationPhase(lp.id, 'startAge', value)} min={initialData.age} max={Math.max(initialData.age, getDisplayedPhaseEndAge(lp.endAge, planToAge, idx < locationPhases.length - 1) - 1)} className="w-12 bg-white border border-warm-200 rounded px-1 py-0.5 text-center text-xs" />
                            <span>→</span>
                            <NumberCommitInput value={getDisplayedPhaseEndAge(lp.endAge, planToAge, idx < locationPhases.length - 1)} onCommit={value => updateLocationPhase(lp.id, 'endAge', getInternalPhaseEndAge(value, planToAge, idx < locationPhases.length - 1))} min={lp.startAge + 1} max={planToAge} className="w-12 bg-white border border-warm-200 rounded px-1 py-0.5 text-center text-xs" />
                          </div>
                        </div>
                      ))}
                      <div className="bg-warm-50 rounded-xl p-3 text-xs text-warm-500 space-y-1 border border-warm-100">
                        <div className="flex justify-between"><span>Now: {COUNTRY_DATA[currentLoc.country].flag} {currentLoc.country === 'USA' ? currentLoc.state : currentLoc.country}</span><span className="font-semibold text-warm-700">{currentTax.label}</span></div>
                        <div className="flex justify-between border-t border-warm-200 pt-1 mt-1 font-bold text-warm-800"><span>Effective tax</span><span>{effectiveTaxRate.toFixed(1)}%</span></div>
                        <div className="flex justify-between font-semibold text-warm-700"><span>Net income</span><span>{formatCurrencyFull(netIncome)}</span></div>
                      </div>
                    </div>
                  </div>
                </CollapsibleSection>

                <CollapsibleSection
                  title="Monthly Expenses"
                  summary={`${formatCurrency(currentMonthlyExpenses)}/mo now · ${formatCurrency(retirementMonthlyExpenses)}/mo at retirement`}
                  isOpen={!!openSections.expenses}
                  onToggle={() => toggleSection('expenses')}
                >
                  <div className="animate-fade-in">
                <div className="flex justify-between items-center mb-2">
                  <span className="text-sm font-semibold text-warm-800">Monthly Expenses <span className="text-warm-400 font-normal">— ${currentMonthlyExpenses.toLocaleString()}/mo total</span></span>
                  <div className="flex gap-2">
                    {locationPhases.length > 1 && (
                      <button onClick={() => {
                        // Split all expense phases at location boundary ages
                        const boundaries = locationPhases.map(lp => lp.startAge).filter(a => a > currentAge);
                        setExpenses(expenses.map(exp => {
                          let newPhases = [...exp.phases];
                          for (const boundary of boundaries) {
                            const splitPhases = [];
                            for (const ph of newPhases) {
                              if (ph.startAge < boundary && ph.endAge > boundary) {
                                splitPhases.push({ ...ph, endAge: boundary });
                                splitPhases.push({ ...ph, id: Date.now() + Math.random(), startAge: boundary });
                              } else {
                                splitPhases.push(ph);
                              }
                            }
                            newPhases = splitPhases;
                          }
                          return { ...exp, phases: newPhases };
                        }));
                      }} className="text-[10px] flex items-center gap-1 text-sky hover:text-sky/80 font-semibold bg-sky-light px-2 py-1 rounded-lg">
                        <MapPin size={10} /> Sync with Locations
                      </button>
                    )}
                    <button onClick={handleAddExpense} className="text-xs flex items-center gap-1 text-warm-500 hover:text-warm-700 font-semibold">
                      <Plus size={14} /> Add Category
                    </button>
                  </div>
                </div>
                {locationPhases.length > 1 && (
                  <div className="flex gap-1.5 mb-3 text-[10px]">
                    {locationPhases.map(lp => (
                      <div key={lp.id} className="bg-warm-50 rounded-lg px-2 py-1 border border-warm-100 text-warm-500">
                        {COUNTRY_DATA[lp.country]?.flag} {lp.startAge}–{lp.endAge - 1}
                      </div>
                    ))}
                  </div>
                )}
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
                  {expenses.map(exp => {
                    const isExp = !!expandedExpenses[exp.id];
                    const amt = getExpenseAtAge(exp, currentAge);
                    return (
                      <div key={exp.id} className={`rounded-xl border transition-all ${isExp ? 'border-warm-300 bg-white shadow-sm' : 'border-warm-100 bg-warm-50/50'}`}>
                        <div className="flex items-center gap-1.5 p-2.5 cursor-pointer" onClick={() => setExpandedExpenses(p => ({ ...p, [exp.id]: !p[exp.id] }))}>
                          <button onClick={e => { e.stopPropagation(); handleRemoveExpense(exp.id); }} className="text-warm-200 hover:text-coral"><Trash2 size={13} /></button>
                          {isExp ? <ChevronDown size={12} className="text-warm-500" /> : <ChevronRight size={12} className="text-warm-300" />}
                          <input type="text" value={exp.name} onClick={e => e.stopPropagation()} onChange={e => handleUpdateExpense(exp.id, 'name', e.target.value)}
                            className="flex-1 bg-transparent text-xs font-medium text-warm-800 focus:outline-none" />
                          <span className="text-xs font-semibold text-warm-600">${amt.toLocaleString()}</span>
                          <span className="text-[9px] text-warm-300 bg-warm-50 px-1.5 py-0.5 rounded-full">{exp.phases.length}p</span>
                          <input type="checkbox" checked={exp.isMedical} onClick={e => e.stopPropagation()} onChange={e => handleUpdateExpense(exp.id, 'isMedical', e.target.checked)}
                            className="w-3 h-3 accent-coral cursor-pointer" title="Medical" />
                        </div>
                        {isExp && (
                          <div className="px-2.5 pb-2.5 pt-1 border-t border-warm-100 space-y-1.5">
                            {exp.phases.map((ph, phaseIndex) => {
                              const phaseLoc = getLocationAtAge(ph.startAge);
                              const hasNextPhase = phaseIndex < exp.phases.length - 1;
                              return (
                                <div key={ph.id} className="flex items-center gap-2 text-xs bg-cream p-1.5 rounded-lg">
                                  <span className="text-[10px]" title={phaseLoc.country}>{COUNTRY_DATA[phaseLoc.country]?.flag}</span>
                                  <span className="text-warm-400">$</span>
                                  <NumberCommitInput value={ph.amount} onCommit={value => handleUpdatePhase(exp.id, ph.id, 'amount', value)} min={0} max={1000000}
                                    className="w-16 bg-white border border-warm-200 rounded-lg px-1.5 py-0.5 text-center text-xs focus:outline-none focus:border-warm-400" />
                                  <span className="text-warm-300">/mo</span>
                                  <NumberCommitInput value={ph.startAge} onCommit={value => handleUpdatePhase(exp.id, ph.id, 'startAge', value)} min={currentAge} max={Math.max(currentAge, getDisplayedPhaseEndAge(ph.endAge, planToAge, hasNextPhase) - 1)}
                                    className="w-11 bg-white border border-warm-200 rounded-lg px-1 py-0.5 text-center text-xs focus:outline-none focus:border-warm-400" />
                                  <span className="text-warm-300">→</span>
                                  <NumberCommitInput value={getDisplayedPhaseEndAge(ph.endAge, planToAge, hasNextPhase)} onCommit={value => handleUpdatePhase(exp.id, ph.id, 'endAge', getInternalPhaseEndAge(value, planToAge, hasNextPhase))} min={ph.startAge + 1} max={planToAge}
                                    className="w-11 bg-white border border-warm-200 rounded-lg px-1 py-0.5 text-center text-xs focus:outline-none focus:border-warm-400" />
                                  {exp.phases.length > 1 && <button onClick={() => handleRemovePhase(exp.id, ph.id)} className="text-warm-200 hover:text-coral ml-auto"><Trash2 size={11} /></button>}
                                </div>
                              );
                            })}
                            <button onClick={() => handleAddPhase(exp.id)} className="text-[10px] text-warm-400 hover:text-warm-600 font-semibold flex items-center gap-1"><Plus size={10} /> Phase</button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
                </CollapsibleSection>

                <CollapsibleSection
                  title="Family & Milestones"
                  summary={kids.length === 0 ? 'No milestone plans added yet' : `${kids.length} ${kids.length === 1 ? 'child' : 'kids'} · ${formatCurrencyFull(totalMilestoneCost)}`}
                  isOpen={!!openSections.family}
                  onToggle={() => toggleSection('family')}
                >
                  <div className="animate-fade-in">
                <div className="flex justify-between items-center mb-3">
                  <span className="text-sm font-semibold text-warm-800">
                    Children
                    {kids.length > 0 && <span className="text-warm-400 font-normal"> — {formatCurrencyFull(totalMilestoneCost)} in milestones</span>}
                  </span>
                  <button onClick={() => setKids([...kids, {
                    id: Date.now(), name: `Child ${kids.length + 1}`, birthYear: currentYear,
                    milestones: {
                      highSchool: { enabled: false, startAge: 14, years: 4, annualCost: 30000 },
                      college: { enabled: false, startAge: 18, years: 4, annualCost: 50000 },
                      wedding: { enabled: false, age: 28, cost: 50000 },
                      custom: []
                    }
                  }])} className="text-xs flex items-center gap-1 text-warm-500 hover:text-warm-700 font-semibold">
                    <Plus size={14} /> Add Child
                  </button>
                </div>
                {kids.length === 0 ? (
                  <div className="text-center py-12 text-warm-300">
                    <Heart size={32} className="mx-auto mb-2 opacity-40" />
                    <p className="text-sm">No children added yet</p>
                    <p className="text-xs mt-1">Add children to plan for education, wedding, and other milestones</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {kids.map(kid => (
                      <KidCard key={kid.id} kid={kid} currentAge={currentAge}
                        onUpdate={(id, k) => setKids(kids.map(c => c.id === id ? k : c))}
                        onRemove={(id) => setKids(kids.filter(c => c.id !== id))} />
                    ))}
                  </div>
                )}
              </div>
                </CollapsibleSection>

                <CollapsibleSection
                  title="Annual Savings"
                  summary={`${formatCurrency(annualContribution)}/yr · ${formatCurrencyFull(currentSavings)} starting portfolio`}
                  isOpen={!!openSections.savings}
                  onToggle={() => toggleSection('savings')}
                >
                  <div className="animate-fade-in">
                {locationPhases.length > 1 && (
                  <div className="flex gap-1.5 mb-3 text-[10px]">
                    {locationPhases.map(lp => (
                      <div key={lp.id} className="bg-warm-50 rounded-lg px-2 py-1 border border-warm-100 text-warm-500">
                        {COUNTRY_DATA[lp.country]?.flag} {lp.startAge}–{lp.endAge - 1}
                      </div>
                    ))}
                  </div>
                )}
                <p className="text-[10px] text-warm-300 mb-4">
                  {currentLoc.country === 'USA' ? '🇺🇸 US tax-advantaged accounts (401k, Roth, HSA, 529)' :
                   currentLoc.country === 'India' ? '🇮🇳 India: EPF/PPF/NPS are similar tax-advantaged vehicles. Amounts below are annual contributions.' :
                   currentLoc.country === 'Singapore' ? '🇸🇬 Singapore: CPF is the primary tax-advantaged vehicle.' :
                   '🇦🇪 UAE: No income tax — all investment growth is effectively tax-free.'}
                </p>
                <div className="bg-warm-50/50 rounded-xl p-3 mb-4 border border-warm-100">
                  <h3 className="text-[10px] font-bold text-warm-400 uppercase tracking-wider mb-3">Current Balance Split</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                    <Slider label="401(k) Balance" value={bal401k} set={setBal401k} min={0} max={currentSavings} step={1000} format={formatCurrencyFull} />
                    <Slider label="Roth/HSA Balance" value={balRoth} set={setBalRoth} min={0} max={currentSavings} step={1000} format={formatCurrencyFull} />
                    <Slider label="Taxable Balance" value={balTaxable} set={setBalTaxable} min={0} max={currentSavings} step={1000} format={formatCurrencyFull} />
                  </div>
                  <div className="flex justify-between text-xs mt-2 text-warm-400">
                    <span>Total: {formatCurrencyFull(bal401k + balRoth + balTaxable)}</span>
                    {Math.abs((bal401k + balRoth + balTaxable) - currentSavings) > 1000 && (
                      <span className="text-coral font-semibold">Doesn't match savings ({formatCurrencyFull(currentSavings)})</span>
                    )}
                  </div>
                </div>
                <h3 className="text-[10px] font-bold text-warm-400 uppercase tracking-wider mb-3">Annual Contributions</h3>
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
                  <div className="space-y-4">
                    <h3 className="text-[10px] font-bold text-warm-400 uppercase tracking-wider">Tax-Deferred</h3>
                    <Slider label="Your 401(k) + Match" value={my401k} set={setMy401k} min={0} max={75000} step={500} format={formatCurrencyFull} />
                    {hasSpouse && <Slider label="Spouse 401(k) + Match" value={spouse401k} set={setSpouse401k} min={0} max={75000} step={500} format={formatCurrencyFull} />}
                    <p className="text-[10px] text-warm-300">Pre-tax contributions, taxed on withdrawal</p>
                  </div>
                  <div className="space-y-4">
                    <h3 className="text-[10px] font-bold text-sage-500 uppercase tracking-wider">Tax-Free Growth</h3>
                    <Slider label="Roth IRA / Roth 401(k)" value={rothIRA} set={setRothIRA} min={0} max={30000} step={500} format={formatCurrencyFull} />
                    <Slider label="HSA (Health Savings)" value={hsa} set={setHSA} min={0} max={12000} step={100} format={formatCurrencyFull} />
                    <Slider label="529 Education Plan" value={plan529} set={set529} min={0} max={50000} step={500} format={formatCurrencyFull} />
                    <p className="text-[10px] text-sage-400">After-tax contributions, tax-free growth & qualified withdrawals</p>
                  </div>
                  <div className="space-y-4">
                    <h3 className="text-[10px] font-bold text-warm-400 uppercase tracking-wider">Taxable</h3>
                    <Slider label="Other Savings & Investments" value={otherSavings} set={setOtherSavings} min={0} max={500000} step={1000} format={formatCurrencyFull} />
                    <p className="text-[10px] text-warm-300">Brokerage, stocks, bonds — taxed on gains</p>
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap gap-3">
                  <div className="bg-sage-50 rounded-xl p-3 flex justify-between items-center text-sm flex-1 min-w-[200px]">
                    <span className="font-semibold text-sage-800">Total Annual Savings</span>
                    <span className="text-lg font-bold text-sage-700">{formatCurrencyFull(annualContribution)}/yr</span>
                  </div>
                  {taxFreeContribution > 0 && (
                    <div className="bg-sage-50/50 rounded-xl p-3 flex justify-between items-center text-xs flex-1 min-w-[200px] border border-sage-100">
                      <span className="text-sage-600">Tax-free portion</span>
                      <span className="font-bold text-sage-700">{formatCurrencyFull(taxFreeContribution)}/yr ({annualContribution > 0 ? (taxFreeContribution / annualContribution * 100).toFixed(0) : 0}%)</span>
                    </div>
                  )}
                </div>
              </div>
                </CollapsibleSection>

                <CollapsibleSection
                  title="Life Events"
                  summary={enabledLifeLevers === 0 ? 'No life-event overrides enabled' : `${enabledLifeLevers} life-event lever${enabledLifeLevers === 1 ? '' : 's'} active`}
                  isOpen={!!openSections.life}
                  onToggle={() => toggleSection('life')}
                >
                  <div className="animate-fade-in">
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
                  {/* Additional Income */}
                  <div className="space-y-4 rounded-2xl border border-warm-100 bg-warm-50/30 p-4">
                    <h3 className="text-[10px] font-bold text-sage-500 uppercase tracking-wider">Additional Income</h3>
                    <Slider label="Pension / Annuity (annual)" value={pensionIncome} set={setPensionIncome} min={0} max={200000} step={1000} format={formatCurrencyFull} />
                    <Slider label="Pension Starts At" value={pensionStartAge} set={setPensionStartAge} min={50} max={80} format={v => `Age ${v}`} />
                    <Slider label="Rental Income (monthly)" value={rentalIncome} set={setRentalIncome} min={0} max={20000} step={100} format={formatCurrencyFull} />
                    <Slider label="Part-Time Income (annual)" value={partTimeIncome} set={setPartTimeIncome} min={0} max={200000} step={5000} format={formatCurrencyFull} />
                    {partTimeIncome > 0 && <Slider label="Part-Time Until" value={partTimeEndAge} set={setPartTimeEndAge} min={firstRetirementAge} max={80} format={v => `Age ${v}`} />}
                  </div>

                  {/* Healthcare Lifecycle */}
                  <div className="space-y-4 rounded-2xl border border-warm-100 bg-warm-50/30 p-4">
                    <h3 className="text-[10px] font-bold text-coral uppercase tracking-wider">Healthcare</h3>
                    <Slider label="Pre-Medicare Cost (mo)" value={preMedicareCost} set={setPreMedicareCost} min={0} max={5000} step={100} format={formatCurrencyFull} />
                    <Slider label="Post-Medicare Cost (mo)" value={postMedicareCost} set={setPostMedicareCost} min={0} max={3000} step={50} format={formatCurrencyFull} />
                    <p className="text-[10px] text-warm-300">Medicare kicks in at age 65 (US). These costs are <em>added</em> to your existing healthcare expense category.</p>
                    <Slider label="Long-Term Care Starts" value={longTermCareAge} set={setLongTermCareAge} min={70} max={95} format={v => `Age ${v}`} />
                    <Slider label="Long-Term Care (monthly)" value={longTermCareCost} set={setLongTermCareCost} min={0} max={20000} step={500} format={formatCurrencyFull} />
                  </div>

                  {/* Housing */}
                  <div className="space-y-4 rounded-2xl border border-warm-100 bg-warm-50/30 p-4">
                    <h3 className="text-[10px] font-bold text-warm-500 uppercase tracking-wider">Housing & Real Estate</h3>
                    <Slider label="Home Value" value={homeValue} set={setHomeValue} min={0} max={5000000} step={10000} format={formatCurrencyFull} />
                    <Slider label="Mortgage Paid Off At" value={mortgagePayoffAge} set={setMortgagePayoffAge} min={currentAge} max={80} format={v => `Age ${v}`} />
                    <Slider label="Downsize At (0 = never)" value={downsizeAge} set={setDownsizeAge} min={0} max={90} format={v => v === 0 ? 'Never' : `Age ${v}`} />
                    {downsizeAge > 0 && <Slider label="Net Equity from Downsize" value={downsizeEquity} set={setDownsizeEquity} min={0} max={3000000} step={10000} format={formatCurrencyFull} />}
                  </div>

                  {/* Survivor Planning */}
                  <div className="space-y-4 rounded-2xl border border-warm-100 bg-warm-50/30 p-4">
                    <h3 className="text-[10px] font-bold text-warm-500 uppercase tracking-wider">Survivor Planning</h3>
                    {hasSpouse ? (
                      <>
                        <div className="flex items-center gap-2">
                          <input type="checkbox" checked={survivorMode} onChange={e => setSurvivorMode(e.target.checked)} className="w-4 h-4 accent-warm-500 cursor-pointer" />
                          <label className="text-sm font-semibold text-warm-700">Model survivor scenario</label>
                        </div>
                        {survivorMode && (
                          <div className="space-y-4 animate-fade-in">
                            <Slider label="Spouse Passes At" value={survivorAge} set={setSurvivorAge} min={currentAge + 5} max={95} format={v => `Age ${v}`} />
                            <Slider label="Life Insurance Payout" value={lifeInsurance} set={setLifeInsurance} min={0} max={5000000} step={10000} format={formatCurrencyFull} />
                            <p className="text-[10px] text-warm-300">After this age: spouse's SS stops, expenses reduced by 30%, life insurance adds to taxable account.</p>
                          </div>
                        )}
                      </>
                    ) : (
                      <p className="text-xs text-warm-300 py-4">Survivor planning is available when you have a spouse/partner.</p>
                    )}
                  </div>
                </div>
              </div>
                </CollapsibleSection>

                <CollapsibleSection
                  title="Social Security"
                  summary={`${primaryLabel} claims at ${ssClaimAge} · ${formatCurrency(Math.round(adjustedSSMonthly))}/mo`}
                  isOpen={!!openSections.ss}
                  onToggle={() => toggleSection('ss')}
                >
                  <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 animate-fade-in">
                    <div className="space-y-4">
                      <Slider label={`${primaryPossessive} Claim Age`} value={ssClaimAge} set={setSsClaimAge} min={62} max={70} format={v => `Age ${v}`} />
                      <p className="text-xs text-warm-400 bg-sky-light p-3 rounded-lg border border-sky/20">
                        {primaryLabel}'s SS: <strong className="text-sky">${Math.round(adjustedSSMonthly).toLocaleString()}/mo</strong>
                      </p>
                    </div>
                    {hasSpouse ? (
                      <div className="space-y-4">
                        <Slider label={`${spousePossessive} Claim Age`} value={spouseSsClaimAge} set={setSpouseSsClaimAge} min={62} max={70} format={v => `Age ${v}`} />
                        <p className="text-xs text-warm-400 bg-sky-light p-3 rounded-lg border border-sky/20">
                          {spouseLabel}'s SS: <strong className="text-sky">${Math.round(spouseAdjustedSSMonthly).toLocaleString()}/mo</strong>
                        </p>
                      </div>
                    ) : (
                      <div className="rounded-2xl border border-warm-100 bg-warm-50/50 p-4 text-sm text-warm-500">
                        Social Security timing updates here as your income assumptions change.
                      </div>
                    )}
                  </div>
                </CollapsibleSection>
              </div>
            )}

            {activeSection === 'market' && (
              <div className="animate-fade-in">
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
                  <div className="space-y-4 rounded-2xl border border-warm-100 bg-warm-50/30 p-4">
                    <h3 className="text-[10px] font-bold text-warm-400 uppercase tracking-wider">Allocation & Inflation</h3>
                    <Slider label={hasIndiaPhase ? 'Stocks / FD Mix' : 'Stock/Bond Mix'} value={stockAllocation} set={setStockAllocation} min={0} max={100} step={5} format={v => `${v}/${100-v}`} />
                    {hasIndiaPhase && (
                      <Slider label="Fixed Deposit Rate" value={fdRate} set={setFdRate} min={4} max={10} step={0.25} format={v => `${v}%`} />
                    )}
                    <Slider label="Gen. Inflation (override)" value={inflationRate} set={setInflationRate} min={0} max={10} step={0.5} format={v => `${v}%`} />
                    <Slider label="Med. Inflation (override)" value={medicalInflation} set={setMedicalInflation} min={0} max={12} step={0.5} format={v => `${v}%`} />
                    <div className="bg-warm-50 rounded-lg p-2 text-[10px] text-warm-400 space-y-0.5">
                      <p className="font-semibold text-warm-500">Country defaults (used per phase):</p>
                      {Object.entries(COUNTRY_DATA).map(([k, c]) => (
                        <div key={k} className="flex justify-between"><span>{c.flag} {c.label}</span><span className="text-warm-600">{c.defaultInflation}% / Med {c.defaultMedInflation}%</span></div>
                      ))}
                    </div>
                  </div>
                  <div className="space-y-4">
                    <ScenarioInputs label="Optimistic" color="sage" stock={avgStockReturn} setStock={setAvgStockReturn} bond={avgBondReturn} setBond={setAvgBondReturn} blended={blendedAvg} bondLabel={hasIndiaPhase ? undefined : 'Bonds'} />
                    <ScenarioInputs label="Moderate" color="warm" stock={belowStockReturn} setStock={setBelowStockReturn} bond={belowBondReturn} setBond={setBelowBondReturn} blended={blendedBelow} bondLabel={hasIndiaPhase ? undefined : 'Bonds'} />
                    <ScenarioInputs label="Conservative" color="coral" stock={sigStockReturn} setStock={setSigStockReturn} bond={sigBondReturn} setBond={setSigBondReturn} blended={blendedSig} bondLabel={hasIndiaPhase ? undefined : 'Bonds'} />
                  </div>
                </div>
                {hasIndiaPhase && (
                  <p className="text-xs text-warm-400 mt-3 bg-warm-50 p-2.5 rounded-xl">
                    India phases use Fixed Deposit rates (~7% for senior citizens) instead of bond returns. The FD rate applies during India location phases only.
                  </p>
                )}
              </div>
            )}
          </div>

          {activeSection === 'finances' && (
            <div className={`p-5 border-t border-warm-100/60 ${cashFlowSurplus >= 0 ? 'bg-sage-50/60' : 'bg-coral-light/40'}`}>
              <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
                <div>
                  <h3 className="text-base font-semibold text-warm-800">Current annual cash flow</h3>
                  <p className="text-sm text-warm-500 leading-relaxed">Keep this summary visible while adjusting finances so you can see the tradeoffs immediately.</p>
                </div>
                <div className={`text-xl font-bold tracking-tight ${cashFlowSurplus >= 0 ? 'text-sage-700' : 'text-coral'}`}>
                  {cashFlowSurplus >= 0 ? '+' : ''}{formatCurrency(cashFlowSurplus)}/yr
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3 mt-4 text-sm">
                <div className="rounded-2xl border border-white/70 bg-white/75 p-4 flex justify-between gap-3"><span className="text-warm-400">Net income</span><span className="font-semibold text-warm-700 text-right">{formatCurrencyFull(netIncome)}</span></div>
                <div className="rounded-2xl border border-white/70 bg-white/75 p-4 flex justify-between gap-3"><span className="text-warm-400">Living expenses</span><span className="font-semibold text-coral text-right">-{formatCurrencyFull(currentYearlyExpenses)}</span></div>
                <div className="rounded-2xl border border-white/70 bg-white/75 p-4 flex justify-between gap-3"><span className="text-warm-400">Annual savings</span><span className="font-semibold text-sage-600 text-right">-{formatCurrencyFull(annualContribution)}</span></div>
                <div className="rounded-2xl border border-white/70 bg-white/75 p-4 flex justify-between gap-3"><span className="text-warm-400">Milestones this year</span><span className="font-semibold text-warm-700 text-right">-{formatCurrencyFull(currentYearMilestones)}</span></div>
              </div>
            </div>
          )}
        </div>

        <div className="bg-white rounded-[28px] shadow-sm border border-warm-100/30 overflow-hidden">
          <button onClick={() => setShowDetailedAnalysis(v => !v)} className="w-full flex items-center justify-between gap-4 p-6 text-left hover:bg-warm-50/30 transition-colors motion-button">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-2xl bg-warm-50 text-warm-600 flex items-center justify-center">
                <FileText size={18} />
              </div>
              <div>
                <h2 className="text-lg text-warm-900 font-[family-name:var(--font-display)]">Detailed Breakdown</h2>
                <p className="text-sm text-warm-500 leading-relaxed">Milestones table and key-age portfolio waterfall, hidden by default to keep the main dashboard lighter.</p>
              </div>
            </div>
            <div className="flex items-center gap-3 text-xs text-warm-400 font-semibold">
              <span>{showDetailedAnalysis ? 'Hide details' : 'Show details'}</span>
              {showDetailedAnalysis ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            </div>
          </button>

          {showDetailedAnalysis && (
            <div className="p-6 pt-0 border-t border-warm-100/50 animate-fade-in">
              <h3 className="text-lg text-warm-900 font-[family-name:var(--font-display)] mb-4 mt-6">Milestones</h3>
              <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[10px] uppercase tracking-wider text-warm-400 border-b border-warm-100">
                  <th className="py-2 px-3 text-left font-semibold">Age</th>
                  <th className="py-2 px-3 text-left font-semibold">Location</th>
                  <th className="py-2 px-3 text-left font-semibold">Expenses</th>
                  <th className="py-2 px-3 text-left font-semibold text-coral">Est. Tax</th>
                  <th className="py-2 px-3 text-left font-semibold">Net Flow</th>
                  <th className="py-2 px-3 text-left font-semibold text-sage-600">Optimistic</th>
                  <th className="py-2 px-3 text-left font-semibold text-warm-600">Moderate</th>
                  <th className="py-2 px-3 text-left font-semibold text-coral">Conservative</th>
                </tr>
              </thead>
              <tbody>
                {data.filter(d => {
                  // Show every 5 years + key ages + annual rows near shortfall
                  const isRetirementAge = retirementEvents.some(event => event.age === d.age);
                  const isKeyAge = d.age % 5 === 0 || d.age === currentAge || d.age === planToAge || isRetirementAge || d.age === ssClaimAge;
                  const nearShortfall = shortfalls.avg && Math.abs(d.age - shortfalls.avg) <= 2;
                  const isEvent = d.age === medicareAge || (longTermCareCost > 0 && d.age === longTermCareAge) || (downsizeAge > 0 && d.age === downsizeAge) || (survivorMode && d.age === survivorAge);
                  return isKeyAge || nearShortfall || isEvent;
                }).map((d, i) => (
                  <tr key={i} className="border-b border-warm-50 hover:bg-warm-50/50 transition-colors">
                    <td className="py-1.5 px-3 font-medium text-warm-800 text-xs whitespace-nowrap">
                      {d.age} <span className="text-warm-300">({d.year})</span>
                      {retirementEvents.filter(event => event.age === d.age).map(event => (
                        <span key={event.label} className="ml-1 text-[9px] font-bold bg-warm-100 text-warm-600 px-1.5 py-0.5 rounded-full">{event.label.toUpperCase()}</span>
                      ))}
                      {d.age === ssClaimAge && <span className="ml-1 text-[9px] font-bold bg-sky-light text-sky px-1.5 py-0.5 rounded-full">SS</span>}
                      {d.age === medicareAge && <span className="ml-1 text-[9px] font-bold bg-sage-50 text-sage-600 px-1.5 py-0.5 rounded-full">MEDICARE</span>}
                      {longTermCareCost > 0 && d.age === longTermCareAge && <span className="ml-1 text-[9px] font-bold bg-coral-light text-coral px-1.5 py-0.5 rounded-full">LTC</span>}
                      {downsizeAge > 0 && d.age === downsizeAge && <span className="ml-1 text-[9px] font-bold bg-clay-light text-clay px-1.5 py-0.5 rounded-full">SELL</span>}
                      {survivorMode && d.age === survivorAge && <span className="ml-1 text-[9px] font-bold bg-coral-light text-coral px-1.5 py-0.5 rounded-full">SURVIVOR</span>}
                      {shortfalls.avg && d.age === shortfalls.avg && <span className="ml-1 text-[9px] font-bold bg-coral text-white px-1.5 py-0.5 rounded-full">DEPLETED</span>}
                    </td>
                    <td className="py-1.5 px-3 text-warm-400 text-[10px]">{COUNTRY_DATA[d.country]?.flag} {d.country === 'USA' ? getLocationAtAge(d.age)?.state : d.country}</td>
                    <td className="py-1.5 px-3 text-warm-500 text-xs">{formatCurrency(d.yearlyExp)}</td>
                    <td className="py-1.5 px-3 text-coral text-xs">{formatCurrency(d.estTax)}</td>
                    <td className={`py-1.5 px-3 font-medium text-xs ${d.netFlow > 0 ? 'text-sage-600' : 'text-coral'}`}>
                      {d.netFlow > 0 ? '+' : ''}{formatCurrency(d.netFlow)}
                    </td>
                    <td className="py-1.5 px-3 text-warm-700 text-xs">{formatCurrencyFull(d.avg)}</td>
                    <td className="py-1.5 px-3 text-warm-700 text-xs">{formatCurrencyFull(d.below)}</td>
                    <td className="py-1.5 px-3 text-warm-700 text-xs">{formatCurrencyFull(d.sig)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
              </div>

              <div className="mt-4 pt-4 border-t border-warm-100">
                <h3 className="text-xs font-bold text-warm-400 uppercase tracking-wider mb-3">Plan Breakdown at Key Ages</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
              {[...retirementEvents.map(event => event.age), ssClaimAge, shortfalls.avg || planToAge, planToAge].filter((v, i, a) => a.indexOf(v) === i && v >= currentAge && v <= planToAge).map(age => {
                const d = data.find(dd => dd.age === age);
                if (!d) return null;
                const loc = getLocationAtAge(age);
                const inf = Math.pow(1 + (COUNTRY_DATA[loc.country]?.defaultInflation || inflationRate) / 100, age - currentAge);
                const ssAtAge = (age >= ssClaimAge ? adjustedSSMonthly * 12 * inf : 0) + (hasSpouse && age >= spouseSsClaimAge ? spouseAdjustedSSMonthly * 12 * inf : 0);
                const pensionAtAge = age >= pensionStartAge ? pensionIncome * inf : 0;
                const rentalAtAge = rentalIncome * 12 * inf;
                const partTimeAtAge = (d.primaryWorking === false || d.spouseWorking === false) && age < partTimeEndAge ? partTimeIncome * inf : 0;
                return (
                  <div key={age} className="bg-cream rounded-xl p-3 border border-warm-100 text-[10px] space-y-1">
                    <div className="font-bold text-warm-700 text-xs mb-2">
                      Age {age} <span className="text-warm-300">({currentYear + age - currentAge})</span>
                      {retirementEvents.filter(event => event.age === age).map(event => (
                        <span key={event.label} className="ml-1 text-[8px] bg-warm-100 text-warm-600 px-1 py-0.5 rounded">{event.label.toUpperCase()}</span>
                      ))}
                      {shortfalls.avg && age === shortfalls.avg && <span className="ml-1 text-[8px] bg-coral text-white px-1 py-0.5 rounded">DEPLETED</span>}
                    </div>
                    <div className="text-sage-600 font-semibold">Income</div>
                    {d.earnedIncome > 0 && <div className="flex justify-between"><span className="text-warm-400">Salary</span><span className="text-warm-600">{formatCurrency(d.earnedIncome)}</span></div>}
                    {ssAtAge > 0 && <div className="flex justify-between"><span className="text-warm-400">Social Security</span><span className="text-warm-600">{formatCurrency(ssAtAge)}</span></div>}
                    {pensionAtAge > 0 && <div className="flex justify-between"><span className="text-warm-400">Pension</span><span className="text-warm-600">{formatCurrency(pensionAtAge)}</span></div>}
                    {rentalAtAge > 0 && <div className="flex justify-between"><span className="text-warm-400">Rental</span><span className="text-warm-600">{formatCurrency(rentalAtAge)}</span></div>}
                    {partTimeAtAge > 0 && <div className="flex justify-between"><span className="text-warm-400">Part-time</span><span className="text-warm-600">{formatCurrency(partTimeAtAge)}</span></div>}
                    <div className="text-coral font-semibold mt-1">Outflows</div>
                    <div className="flex justify-between"><span className="text-warm-400">Expenses</span><span className="text-coral">{formatCurrency(d.yearlyExp)}</span></div>
                    {d.estTax > 0 && <div className="flex justify-between"><span className="text-warm-400">Tax</span><span className="text-coral">{formatCurrency(d.estTax)}</span></div>}
                    {d.annualContribution > 0 && <div className="flex justify-between"><span className="text-warm-400">Savings</span><span className="text-sage-500">{formatCurrency(d.annualContribution)}</span></div>}
                    <div className="flex justify-between border-t border-warm-200 pt-1 mt-1 font-bold text-warm-800">
                      <span>Net</span><span className={d.netFlow >= 0 ? 'text-sage-600' : 'text-coral'}>{d.netFlow >= 0 ? '+' : ''}{formatCurrency(d.netFlow)}</span>
                    </div>
                    <div className="flex justify-between text-warm-400 mt-1"><span>Portfolio</span><span className="text-warm-600 font-semibold">{formatCurrencyFull(d.avg)}</span></div>
                    {d.accts && d.avg > 0 && (
                      <div className="space-y-0.5 text-[9px] text-warm-300">
                        {d.accts.td > 0 && <div className="flex justify-between"><span>401k</span><span>{formatCurrency(d.accts.td)}</span></div>}
                        {d.accts.tf > 0 && <div className="flex justify-between"><span>Roth</span><span className="text-sage-400">{formatCurrency(d.accts.tf)}</span></div>}
                        {d.accts.tx > 0 && <div className="flex justify-between"><span>Taxable</span><span>{formatCurrency(d.accts.tx)}</span></div>}
                      </div>
                    )}
                  </div>
                );
              })}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── SUB-COMPONENTS ─────────────────────────────────────────

function TabButton({ id, label, icon: Icon, active, set }) {
  return (
    <button
      onClick={() => set(id)}
      className={`flex items-center gap-2 px-4 py-2.5 rounded-t-2xl text-sm font-semibold transition-all motion-button ${
        active ? 'bg-white text-warm-700 shadow-sm border border-warm-100/50 border-b-white -mb-px' : 'text-warm-400 hover:text-warm-600'
      }`}
    >
      <Icon size={14} />
      {label}
    </button>
  );
}

function CollapsibleSection({ title, summary, isOpen, onToggle, children }) {
  return (
    <div className={`rounded-[24px] border transition-all surface-hover ${isOpen ? 'border-warm-300 bg-white shadow-sm shadow-warm-100/30' : 'border-warm-100 bg-slate-50/70'}`}>
      <button onClick={onToggle} className="w-full flex items-center gap-3 p-5 text-left motion-button">
        {isOpen ? <ChevronDown size={17} className="text-warm-600 shrink-0" /> : <ChevronRight size={17} className="text-warm-400 shrink-0" />}
        <span className="text-base font-semibold text-warm-800 flex-1 tracking-tight">{title}</span>
        {!isOpen && <span className="text-sm text-warm-400 text-right max-w-[45%] leading-relaxed">{summary}</span>}
      </button>
      {isOpen && <div className="px-5 pb-5 pt-1 border-t border-warm-100/60">{children}</div>}
    </div>
  );
}

function NumberCommitInput({ value, onCommit, min, max, className }) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commit = () => {
    if (draft.trim() === '') {
      setDraft(String(value));
      return;
    }

    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }

    const clamped = Math.min(max, Math.max(min, parsed));
    setDraft(String(clamped));
    onCommit(clamped);
  };

  return (
    <input
      type="number"
      value={draft}
      onChange={event => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={event => {
        if (event.key === 'Enter') commit();
        if (event.key === 'Escape') setDraft(String(value));
      }}
      className={className}
    />
  );
}

function HelpModal({ open, onClose }) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-warm-900/45 backdrop-blur-sm p-4">
      <div className="w-full max-w-3xl rounded-[28px] border border-warm-100/60 bg-white shadow-2xl shadow-warm-900/10 overflow-hidden animate-fade-in-up">
        <div className="flex items-start justify-between gap-4 px-6 py-5 border-b border-warm-100/60 bg-warm-50/60">
          <div>
            <p className="text-[11px] uppercase tracking-[0.18em] text-warm-400 mb-2">Guide</p>
            <h2 className="text-2xl text-warm-900 font-[family-name:var(--font-display)]">How To Use This Planner</h2>
          </div>
          <button onClick={onClose} className="px-3 py-2 rounded-xl bg-white border border-warm-100 text-warm-600 text-sm font-semibold motion-button">
            Close
          </button>
        </div>
        <div className="px-6 py-6 grid grid-cols-1 md:grid-cols-2 gap-4 text-sm text-warm-600 leading-relaxed max-h-[70vh] overflow-y-auto">
          <div className="rounded-2xl border border-warm-100 bg-warm-50/40 p-4">
            <h3 className="text-base text-warm-800 font-semibold mb-2">1. Create and unlock a vault</h3>
            <p>Set a passphrase for this browser. Saved plans are encrypted locally, and the same passphrase unlocks them later or restores encrypted backups.</p>
          </div>
          <div className="rounded-2xl border border-warm-100 bg-warm-50/40 p-4">
            <h3 className="text-base text-warm-800 font-semibold mb-2">2. Use named plans</h3>
            <p>Create one plan per scenario. Duplicate plans when you want to compare retirement ages, locations, or spending without overwriting the original.</p>
          </div>
          <div className="rounded-2xl border border-warm-100 bg-warm-50/40 p-4">
            <h3 className="text-base text-warm-800 font-semibold mb-2">3. Fill finances first</h3>
            <p>Set ages, retirement timing, income, savings, and balances. The chart and cash-flow summary update automatically as you change inputs.</p>
          </div>
          <div className="rounded-2xl border border-warm-100 bg-warm-50/40 p-4">
            <h3 className="text-base text-warm-800 font-semibold mb-2">4. Understand phases</h3>
            <p>Location and expense phases change assumptions over time. The end age box is the handoff point where the next phase begins. The final phase still covers your selected model age.</p>
          </div>
          <div className="rounded-2xl border border-warm-100 bg-warm-50/40 p-4">
            <h3 className="text-base text-warm-800 font-semibold mb-2">5. Read the results</h3>
            <p>The main chart shows optimistic, moderate, and conservative trajectories. Event markers highlight retirement and other milestones, while the cards summarize risk and ending balances.</p>
          </div>
          <div className="rounded-2xl border border-warm-100 bg-warm-50/40 p-4">
            <h3 className="text-base text-warm-800 font-semibold mb-2">6. Back up your data</h3>
            <p>Use Backup to download an encrypted file for the current plan. Import encrypted backups from the plans page or from the initial setup screen.</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function ScenarioCard({ title, balance, shortfallAge, color, accounts }) {
  const isShortfall = shortfallAge !== null;
  const colors = {
    sage: { bg: 'bg-sage-50', border: 'border-sage-200', text: 'text-sage-800', accent: 'text-sage-600' },
    warm: { bg: 'bg-warm-50', border: 'border-warm-200', text: 'text-warm-800', accent: 'text-warm-600' },
    coral: { bg: 'bg-coral-light', border: 'border-coral', text: 'text-warm-800', accent: 'text-coral' },
  }[color];

  return (
    <div className={`p-5 rounded-[24px] border ${colors.border} ${colors.bg} flex flex-col min-h-[172px] surface-hover`}>
      <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-warm-400 mb-3">{title}</span>
      {isShortfall ? (
        <div>
          <span className="text-xs text-coral flex items-center gap-1.5 mb-2"><AlertTriangle size={12} /> Runs out at</span>
          <span className="text-3xl font-bold text-coral font-[family-name:var(--font-display)] leading-none">Age {shortfallAge}</span>
        </div>
      ) : (
        <div>
          <span className="text-xs uppercase tracking-wide text-warm-400 mb-1 block">Final balance</span>
          <span className={`text-2xl font-bold ${colors.accent} font-[family-name:var(--font-display)] leading-tight`}>{formatCurrencyFull(balance)}</span>
        </div>
      )}
      {accounts && !isShortfall && (
        <div className="mt-4 pt-3 border-t border-warm-100/50 space-y-1 text-[11px] text-warm-400 leading-relaxed">
          {accounts.taxDeferred > 0 && <div className="flex justify-between"><span>401(k)</span><span>{formatCurrency(accounts.taxDeferred)}</span></div>}
          {accounts.taxFree > 0 && <div className="flex justify-between"><span>Roth/HSA</span><span className="text-sage-500">{formatCurrency(accounts.taxFree)}</span></div>}
          {accounts.taxable > 0 && <div className="flex justify-between"><span>Taxable</span><span>{formatCurrency(accounts.taxable)}</span></div>}
        </div>
      )}
    </div>
  );
}

function Slider({ label, value, set, min, max, step = 1, format }) {
  const [editing, setEditing] = useState(false);
  const [editVal, setEditVal] = useState('');
  return (
    <div className="space-y-2.5">
      <div className="flex justify-between items-center">
        <label className="text-[11px] uppercase tracking-[0.14em] font-semibold text-warm-500">{label}</label>
        {editing ? (
          <input type="text" autoFocus value={editVal}
            onChange={e => setEditVal(e.target.value)}
            onBlur={() => {
              const num = parseFloat(editVal.replace(/[^0-9.-]/g, ''));
              if (!isNaN(num)) set(Math.min(max, Math.max(min, Math.round(num / step) * step)));
              setEditing(false);
            }}
            onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') setEditing(false); }}
            className="text-sm font-bold text-warm-700 bg-white px-3 py-1.5 rounded-xl w-28 text-right border border-warm-300 focus:outline-none focus:border-warm-500"
          />
        ) : (
          <button onClick={() => { setEditVal(String(value)); setEditing(true); }}
            className="text-sm font-bold text-warm-600 bg-warm-50 px-3 py-1.5 rounded-xl hover:bg-warm-100 transition-colors cursor-text shadow-sm shadow-warm-100/20 motion-button">
            {format(value)}
          </button>
        )}
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={e => set(Number(e.target.value))} className="w-full" />
    </div>
  );
}

function ScenarioInputs({ label, color, stock, setStock, bond, setBond, blended, bondLabel }) {
  const bg = { sage: 'bg-sage-50 border-sage-100', warm: 'bg-warm-50 border-warm-100', coral: 'bg-coral-light/50 border-coral/20' }[color];
  return (
    <div className={`p-4 rounded-2xl border ${bg} space-y-3 surface-hover`}>
      <div className="flex justify-between text-xs font-semibold">
        <span className="text-warm-600 uppercase tracking-[0.14em]">{label}</span>
        <span className="text-warm-400">Blend: {blended.toFixed(1)}%</span>
      </div>
      <Slider label="Stocks" value={stock} set={setStock} min={0} max={12} step={0.5} format={v => `${v}%`} />
      <Slider label={bondLabel || 'Bonds'} value={bond} set={setBond} min={0} max={8} step={0.5} format={v => `${v}%`} />
    </div>
  );
}

function MilestoneRow({ label, enabled, onToggle, children }) {
  return (
    <div className={`p-3 rounded-xl border text-xs ${enabled ? 'border-warm-300 bg-warm-50/50' : 'border-warm-100 bg-cream'}`}>
      <div className="flex items-center gap-2">
        <input type="checkbox" checked={enabled} onChange={onToggle} className="w-3.5 h-3.5 accent-warm-500 cursor-pointer" />
        <span className={`font-semibold ${enabled ? 'text-warm-700' : 'text-warm-300'}`}>{label}</span>
      </div>
      {enabled && <div className="flex flex-wrap gap-x-2.5 gap-y-1.5 items-center ml-5 mt-2 text-[11px] leading-relaxed">{children}</div>}
    </div>
  );
}

function KidCard({ kid, onUpdate, onRemove, currentAge }) {
  const update = (type, field, value) => onUpdate(kid.id, { ...kid, milestones: { ...kid.milestones, [type]: { ...kid.milestones[type], [field]: value } } });
  const addCustom = () => onUpdate(kid.id, { ...kid, milestones: { ...kid.milestones, custom: [...kid.milestones.custom, { id: Date.now(), name: 'Custom', age: 18, years: 1, annualCost: 10000 }] } });
  const updateCustom = (cid, f, v) => onUpdate(kid.id, { ...kid, milestones: { ...kid.milestones, custom: kid.milestones.custom.map(c => c.id === cid ? { ...c, [f]: v } : c) } });
  const removeCustom = (cid) => onUpdate(kid.id, { ...kid, milestones: { ...kid.milestones, custom: kid.milestones.custom.filter(c => c.id !== cid) } });
  const userAge = (y) => y - (currentYear - currentAge);
  const yearLabel = (sa, yrs) => { const s = kid.birthYear + sa; return `${s}-${s+yrs-1} (you: ${userAge(s)}-${userAge(s+yrs-1)})`; };
  const m = kid.milestones;
  const si = "w-12 bg-white border border-warm-200 rounded-lg px-1 py-0.5 text-center text-xs focus:outline-none focus:border-warm-400";

  return (
    <div className="p-4 rounded-2xl border border-warm-200 bg-white space-y-3 shadow-sm shadow-warm-100/10 surface-hover">
      <div className="flex items-center gap-2">
        <input type="text" value={kid.name} onChange={e => onUpdate(kid.id, { ...kid, name: e.target.value })}
          className="flex-1 bg-transparent border border-warm-200 rounded-xl px-3 py-1.5 text-sm font-semibold text-warm-800 focus:outline-none focus:border-warm-400" />
        <span className="text-[11px] uppercase tracking-wide text-warm-300">Born</span>
        <input type="number" value={kid.birthYear} onChange={e => onUpdate(kid.id, { ...kid, birthYear: Number(e.target.value) })}
          className="w-[4.5rem] bg-white border border-warm-200 rounded-xl px-2 py-1.5 text-xs text-center focus:outline-none focus:border-warm-400" />
        <button onClick={() => onRemove(kid.id)} className="text-warm-200 hover:text-coral"><Trash2 size={14} /></button>
      </div>
      <MilestoneRow label="High School" enabled={m.highSchool.enabled} onToggle={e => update('highSchool', 'enabled', e.target.checked)}>
        $<input type="number" value={m.highSchool.annualCost} onChange={e => update('highSchool', 'annualCost', Number(e.target.value))} className="w-14 bg-white border border-warm-200 rounded-lg px-1 py-0.5 text-center text-xs" />/yr
        age<input type="number" value={m.highSchool.startAge} onChange={e => update('highSchool', 'startAge', Number(e.target.value))} className={si} />
        for<input type="number" value={m.highSchool.years} onChange={e => update('highSchool', 'years', Number(e.target.value))} className={si} />yrs
        <span className="text-warm-300 text-[10px]">{yearLabel(m.highSchool.startAge, m.highSchool.years)}</span>
        <span className="text-warm-500 text-[10px] font-semibold ml-auto">{formatCurrency(m.highSchool.annualCost * m.highSchool.years)}</span>
      </MilestoneRow>
      <MilestoneRow label="College" enabled={m.college.enabled} onToggle={e => update('college', 'enabled', e.target.checked)}>
        $<input type="number" value={m.college.annualCost} onChange={e => update('college', 'annualCost', Number(e.target.value))} className="w-14 bg-white border border-warm-200 rounded-lg px-1 py-0.5 text-center text-xs" />/yr
        age<input type="number" value={m.college.startAge} onChange={e => update('college', 'startAge', Number(e.target.value))} className={si} />
        for<input type="number" value={m.college.years} onChange={e => update('college', 'years', Number(e.target.value))} className={si} />yrs
        <span className="text-warm-300 text-[10px]">{yearLabel(m.college.startAge, m.college.years)}</span>
        <span className="text-warm-500 text-[10px] font-semibold ml-auto">{formatCurrency(m.college.annualCost * m.college.years)}</span>
      </MilestoneRow>
      <MilestoneRow label="Wedding" enabled={m.wedding.enabled} onToggle={e => update('wedding', 'enabled', e.target.checked)}>
        $<input type="number" value={m.wedding.cost} onChange={e => update('wedding', 'cost', Number(e.target.value))} className="w-14 bg-white border border-warm-200 rounded-lg px-1 py-0.5 text-center text-xs" />
        at age<input type="number" value={m.wedding.age} onChange={e => update('wedding', 'age', Number(e.target.value))} className={si} />
        <span className="text-warm-300 text-[10px]">{kid.birthYear + m.wedding.age} (you: {userAge(kid.birthYear + m.wedding.age)})</span>
        <span className="text-warm-500 text-[10px] font-semibold ml-auto">{formatCurrency(m.wedding.cost)}</span>
      </MilestoneRow>
      {m.custom.map(c => (
        <div key={c.id} className="p-2 rounded-lg border border-warm-200 bg-warm-50/30 text-xs space-y-1">
          <div className="flex items-center gap-2">
            <input type="text" value={c.name} onChange={e => updateCustom(c.id, 'name', e.target.value)} className="flex-1 bg-white border border-warm-200 rounded-lg px-1.5 py-0.5 text-xs" />
            <button onClick={() => removeCustom(c.id)} className="text-warm-200 hover:text-coral"><Trash2 size={11} /></button>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            $<input type="number" value={c.annualCost} onChange={e => updateCustom(c.id, 'annualCost', Number(e.target.value))} className="w-14 bg-white border border-warm-200 rounded-lg px-1 py-0.5 text-center text-xs" />/yr
            age<input type="number" value={c.age} onChange={e => updateCustom(c.id, 'age', Number(e.target.value))} className={si} />
            for<input type="number" value={c.years} onChange={e => updateCustom(c.id, 'years', Number(e.target.value))} className={si} />yrs
            <span className="text-warm-500 text-[10px] font-semibold ml-auto">{formatCurrency(c.annualCost * (c.years || 1))}</span>
          </div>
        </div>
      ))}
      <button onClick={addCustom} className="text-[10px] text-warm-400 hover:text-warm-600 font-semibold flex items-center gap-1"><Plus size={10} /> Custom Event</button>
    </div>
  );
}

function ImportBackupButton({ onImport, className, children }) {
  const inputId = React.useId();

  return (
    <>
      <input
        id={inputId}
        type="file"
        accept="application/json,.json"
        className="sr-only"
        onChange={event => {
          const file = event.target.files?.[0];
          if (file) onImport(file);
          event.target.value = '';
        }}
      />
      <label htmlFor={inputId} className={className}>
        {children}
      </label>
    </>
  );
}

function PlanSetupScreen({ planName, setPlanName, onContinue, onBack, hasExistingPlans, onImportBackup }) {
  const trimmedName = planName.trim();

  return (
    <div className="min-h-screen bg-cream flex items-center justify-center p-4">
      <div className="w-full max-w-lg">
        <div className="bg-white rounded-3xl shadow-lg shadow-warm-100/50 border border-warm-100/30 overflow-hidden animate-fade-in-up">
          <div className="bg-gradient-to-br from-warm-50 to-cream p-8 text-center">
            <Save size={32} className="mx-auto mb-3 text-warm-500" />
            <h1 className="text-2xl text-warm-900 font-[family-name:var(--font-display)]">Start With A Plan</h1>
            <p className="text-warm-600 mt-1 font-light">Create a named plan first, then fill in the retirement details inside that plan.</p>
          </div>

          <div className="p-8 space-y-5">
            <div>
              <label className="block text-sm font-semibold text-warm-800 mb-2">Plan name</label>
              <input
                type="text"
                value={planName}
                onChange={e => setPlanName(e.target.value)}
                placeholder="Family retirement plan"
                className="w-full border border-warm-200 bg-cream/60 rounded-2xl px-4 py-3 text-base text-warm-800 focus:outline-none focus:border-warm-400 focus:bg-white transition-colors"
              />
              <p className="text-xs text-warm-400 mt-2">You can duplicate, rename in storage later, or create additional plan variants from the plan picker.</p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
              <div className="rounded-2xl border border-warm-100 bg-warm-50/50 p-4">
                <div className="text-[10px] uppercase tracking-[0.18em] text-warm-400 font-semibold mb-2">Why first</div>
                <div className="text-warm-700 font-semibold">Every forecast stays attached to a named scenario.</div>
              </div>
              <div className="rounded-2xl border border-warm-100 bg-warm-50/50 p-4">
                <div className="text-[10px] uppercase tracking-[0.18em] text-warm-400 font-semibold mb-2">Useful for</div>
                <div className="text-warm-700 font-semibold">Comparing retirement ages, relocation ideas, or spending changes.</div>
              </div>
              <div className="rounded-2xl border border-warm-100 bg-warm-50/50 p-4">
                <div className="text-[10px] uppercase tracking-[0.18em] text-warm-400 font-semibold mb-2">Next step</div>
                <div className="text-warm-700 font-semibold">Once named, the onboarding wizard will build out this plan.</div>
              </div>
            </div>
          </div>

          <div className="px-8 pb-8 flex items-center justify-between gap-3">
            {hasExistingPlans ? (
              <button onClick={onBack} className="flex items-center gap-1 text-warm-400 hover:text-warm-600 text-sm font-medium transition-colors">
                <ArrowLeft size={16} /> Back to plans
              </button>
            ) : <div />}
            <div className="flex items-center gap-2">
              {onImportBackup && (
                <ImportBackupButton
                  onImport={onImportBackup}
                  className="px-4 py-2 rounded-xl bg-warm-50 text-warm-700 text-sm font-semibold motion-button cursor-pointer"
                >
                  Import encrypted backup
                </ImportBackupButton>
              )}
              <button
                onClick={onContinue}
                disabled={!trimmedName}
                className="flex items-center gap-1 bg-warm-500 hover:bg-warm-600 disabled:bg-warm-200 disabled:text-white/70 text-white px-6 py-2.5 rounded-xl font-semibold text-sm transition-all shadow-md shadow-warm-200 hover:shadow-lg disabled:shadow-none disabled:cursor-not-allowed"
              >
                Continue to setup <ArrowRight size={16} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function VaultAccessScreen({ mode, onSetup, onUnlock, onReset, busy, error, hasMigratingPlans }) {
  const [passphrase, setPassphrase] = useState('');
  const [confirmPassphrase, setConfirmPassphrase] = useState('');
  const isSetup = mode === 'setup';
  const trimmedPassphrase = passphrase.trim();
  const trimmedConfirm = confirmPassphrase.trim();
  const canContinue = isSetup
    ? trimmedPassphrase.length >= 8 && trimmedPassphrase === trimmedConfirm
    : trimmedPassphrase.length > 0;

  const handleSubmit = () => {
    if (!canContinue || busy) return;
    if (isSetup) onSetup(trimmedPassphrase);
    else onUnlock(trimmedPassphrase);
  };

  return (
    <div className="min-h-screen bg-cream flex items-center justify-center p-4">
      <div className="w-full max-w-lg">
        <div className="bg-white rounded-3xl shadow-lg shadow-warm-100/50 border border-warm-100/30 overflow-hidden animate-fade-in-up">
          <div className="bg-gradient-to-br from-warm-50 to-cream p-8 text-center">
            <ShieldAlert size={32} className="mx-auto mb-3 text-warm-500" />
            <h1 className="text-2xl text-warm-900 font-[family-name:var(--font-display)]">{isSetup ? 'Protect This Device' : 'Unlock Your Plans'}</h1>
            <p className="text-warm-600 mt-1 font-light">
              {isSetup
                ? 'Create a passphrase. Saved plans will be encrypted in this browser before they touch local storage.'
                : 'Enter your passphrase to decrypt the saved plans stored on this device.'}
            </p>
          </div>

          <div className="p-8 space-y-5">
            {hasMigratingPlans && isSetup && (
              <div className="rounded-2xl border border-sky/20 bg-sky-light p-4 text-sm text-sky leading-relaxed">
                Existing plans were found on this device. Setting a passphrase will migrate them into encrypted storage.
              </div>
            )}

            <div>
              <label className="block text-sm font-semibold text-warm-800 mb-2">Passphrase</label>
              <input
                type="password"
                value={passphrase}
                onChange={event => setPassphrase(event.target.value)}
                placeholder={isSetup ? 'Use at least 8 characters' : 'Enter your passphrase'}
                className="w-full border border-warm-200 bg-cream/60 rounded-2xl px-4 py-3 text-base text-warm-800 focus:outline-none focus:border-warm-400 focus:bg-white transition-colors"
              />
              {isSetup && <p className="text-xs text-warm-400 mt-2">This passphrase never leaves the browser and cannot be recovered if forgotten.</p>}
            </div>

            {isSetup && (
              <div>
                <label className="block text-sm font-semibold text-warm-800 mb-2">Confirm passphrase</label>
                <input
                  type="password"
                  value={confirmPassphrase}
                  onChange={event => setConfirmPassphrase(event.target.value)}
                  placeholder="Repeat your passphrase"
                  className="w-full border border-warm-200 bg-cream/60 rounded-2xl px-4 py-3 text-base text-warm-800 focus:outline-none focus:border-warm-400 focus:bg-white transition-colors"
                />
                {trimmedConfirm && trimmedConfirm !== trimmedPassphrase && <p className="text-xs text-coral mt-2">Passphrases do not match.</p>}
              </div>
            )}

            {error && (
              <div className="rounded-2xl border border-coral bg-coral-light p-4 text-sm text-coral leading-relaxed">
                {error}
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
              <div className="rounded-2xl border border-warm-100 bg-warm-50/50 p-4">
                <div className="text-[10px] uppercase tracking-[0.18em] text-warm-400 font-semibold mb-2">What it does</div>
                <div className="text-warm-700 font-semibold">Encrypts all saved plans locally with AES-GCM before storage.</div>
              </div>
              <div className="rounded-2xl border border-warm-100 bg-warm-50/50 p-4">
                <div className="text-[10px] uppercase tracking-[0.18em] text-warm-400 font-semibold mb-2">What it does not</div>
                <div className="text-warm-700 font-semibold">It does not create online accounts or server-side access control.</div>
              </div>
              <div className="rounded-2xl border border-warm-100 bg-warm-50/50 p-4">
                <div className="text-[10px] uppercase tracking-[0.18em] text-warm-400 font-semibold mb-2">Recovery</div>
                <div className="text-warm-700 font-semibold">If you forget the passphrase, the only recovery is resetting local device data.</div>
              </div>
            </div>

            <div className="rounded-2xl border border-warm-100 bg-warm-50/40 p-4 text-sm text-warm-600 leading-relaxed">
              Anyone with the link can still open the app shell. The passphrase protects saved data on this browser and encrypted backup files, not access to the website itself.
            </div>
          </div>

          <div className="px-8 pb-8 flex items-center justify-between gap-3">
            <button onClick={onReset} className="text-sm font-medium text-warm-400 hover:text-warm-600 transition-colors">
              Reset device data
            </button>
            <button
              onClick={handleSubmit}
              disabled={!canContinue || busy}
              className="flex items-center gap-1 bg-warm-500 hover:bg-warm-600 disabled:bg-warm-200 disabled:text-white/70 text-white px-6 py-2.5 rounded-xl font-semibold text-sm transition-all shadow-md shadow-warm-200 hover:shadow-lg disabled:shadow-none disabled:cursor-not-allowed"
            >
              {busy ? 'Working...' : isSetup ? 'Create secure vault' : 'Unlock plans'} <ArrowRight size={16} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function PlanComparisonCard({ summary, isActive, onOpen, onDuplicate, onDelete, onRename }) {
  const [isRenaming, setIsRenaming] = useState(false);
  const [draftName, setDraftName] = useState(summary.name);

  useEffect(() => {
    setDraftName(summary.name);
  }, [summary.name]);

  const commitRename = () => {
    const trimmed = draftName.trim();
    if (!trimmed || trimmed === summary.name) {
      setDraftName(summary.name);
      setIsRenaming(false);
      return;
    }
    onRename(trimmed);
    setIsRenaming(false);
  };

  return (
    <div className={`rounded-[24px] border p-5 bg-white shadow-sm surface-hover ${isActive ? 'border-warm-300 shadow-warm-100/40' : 'border-warm-100/80'}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            {isRenaming ? (
              <input
                type="text"
                autoFocus
                value={draftName}
                onChange={e => setDraftName(e.target.value)}
                onBlur={commitRename}
                onKeyDown={e => {
                  if (e.key === 'Enter') commitRename();
                  if (e.key === 'Escape') {
                    setDraftName(summary.name);
                    setIsRenaming(false);
                  }
                }}
                className="text-lg font-semibold text-warm-800 bg-white border border-warm-200 rounded-xl px-3 py-1.5 focus:outline-none focus:border-warm-400"
              />
            ) : (
              <button onClick={() => setIsRenaming(true)} className="text-lg font-semibold text-warm-800 hover:text-warm-600 text-left motion-button">
                {summary.name}
              </button>
            )}
            {isActive && <span className="text-[10px] uppercase tracking-[0.18em] px-2 py-1 rounded-full bg-warm-100 text-warm-700 font-semibold">Active</span>}
          </div>
          <p className="text-sm text-warm-400 mt-1">{summary.hasSpouse ? `${summary.myName} and ${summary.spouseName || 'partner'}` : summary.myName}</p>
          <p className="text-xs text-warm-400 mt-1">Updated {new Date(summary.updatedAt).toLocaleDateString()}</p>
        </div>
        <div className="text-right">
          <div className={`text-lg font-bold ${summary.cashFlow >= 0 ? 'text-sage-700' : 'text-coral'}`}>{summary.cashFlow >= 0 ? '+' : ''}{formatCurrency(summary.cashFlow)}</div>
          <div className="text-[11px] text-warm-400 uppercase tracking-[0.14em]">Cash flow</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 mt-4 text-sm">
        <div className="rounded-2xl bg-warm-50/60 border border-warm-100 p-3">
          <div className="text-[10px] uppercase tracking-[0.14em] text-warm-400 font-semibold mb-1">Retire</div>
          <div className="text-warm-800 font-semibold">{summary.retirementLabel}</div>
          <div className="text-xs text-warm-500 mt-1">{summary.yearsToFirstRetirement} years to first retirement</div>
        </div>
        <div className="rounded-2xl bg-warm-50/60 border border-warm-100 p-3">
          <div className="text-[10px] uppercase tracking-[0.14em] text-warm-400 font-semibold mb-1">Portfolio</div>
          <div className="text-warm-800 font-semibold">{formatCurrencyFull(summary.currentSavings)}</div>
        </div>
        <div className="rounded-2xl bg-warm-50/60 border border-warm-100 p-3">
          <div className="text-[10px] uppercase tracking-[0.14em] text-warm-400 font-semibold mb-1">Income</div>
          <div className="text-warm-800 font-semibold">{formatCurrencyFull(summary.annualIncome)}/yr</div>
        </div>
        <div className="rounded-2xl bg-warm-50/60 border border-warm-100 p-3">
          <div className="text-[10px] uppercase tracking-[0.14em] text-warm-400 font-semibold mb-1">Location</div>
          <div className="text-warm-800 font-semibold">{summary.locationLabel}</div>
        </div>
        <div className="rounded-2xl bg-warm-50/60 border border-warm-100 p-3">
          <div className="text-[10px] uppercase tracking-[0.14em] text-warm-400 font-semibold mb-1">Expenses</div>
          <div className="text-warm-800 font-semibold">{formatCurrency(Math.round(summary.currentMonthlyExpenses))}/mo</div>
        </div>
        <div className="rounded-2xl bg-warm-50/60 border border-warm-100 p-3">
          <div className="text-[10px] uppercase tracking-[0.14em] text-warm-400 font-semibold mb-1">Tax Rate</div>
          <div className="text-warm-800 font-semibold">{summary.effectiveTaxRate.toFixed(1)}%</div>
          <div className="text-xs text-warm-500 mt-1">effective</div>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 mt-4">
        <button onClick={onOpen} className="flex items-center gap-1.5 bg-warm-500 hover:bg-warm-600 text-white px-4 py-2 rounded-xl text-sm font-semibold motion-button">
          <FolderOpen size={14} /> Open
        </button>
        <div className="flex items-center gap-2">
          <button onClick={onDuplicate} className="text-warm-500 hover:text-warm-700 bg-warm-50 px-3 py-2 rounded-xl text-sm font-semibold motion-button">Duplicate</button>
          <button onClick={onDelete} className="text-coral hover:text-coral bg-coral-light px-3 py-2 rounded-xl text-sm font-semibold motion-button">Delete</button>
        </div>
      </div>
    </div>
  );
}

function PlansPage({ plans, activePlanId, onLoadPlan, onDuplicatePlan, onDeletePlan, onRenamePlan, onCreateNewPlan, onClose, allowClose, onImportBackup }) {
  const summaries = plans.map(plan => getPlanSummary(plan)).filter(Boolean);

  return (
    <div className="min-h-screen bg-cream p-4 md:p-6">
      <div className="max-w-[1500px] mx-auto space-y-5 animate-fade-in-up">
        <div className="bg-white rounded-[28px] shadow-sm border border-warm-100/30 p-6 md:p-7">
          <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
            <div>
              <p className="text-[11px] uppercase tracking-[0.18em] text-warm-400 mb-2">Plans</p>
              <h1 className="text-3xl text-warm-900 font-[family-name:var(--font-display)]">Plans & Comparison</h1>
              <p className="text-sm text-warm-500 mt-2 max-w-2xl leading-relaxed">Switch between saved scenarios, duplicate them for experiments, or compare your assumptions side-by-side before making changes.</p>
            </div>
            <div className="flex items-center gap-2">
              {allowClose && (
                <button onClick={onClose} className="px-4 py-2 rounded-xl bg-warm-50 text-warm-700 text-sm font-semibold motion-button">
                  Back to dashboard
                </button>
              )}
              {onImportBackup && (
                <ImportBackupButton
                  onImport={onImportBackup}
                  className="flex items-center gap-2 bg-warm-50 text-warm-700 px-5 py-2.5 rounded-xl font-semibold text-sm motion-button cursor-pointer"
                >
                  <Download size={16} /> Import Backup
                </ImportBackupButton>
              )}
              <button onClick={onCreateNewPlan} className="flex items-center gap-2 bg-warm-500 hover:bg-warm-600 text-white px-5 py-2.5 rounded-xl font-semibold text-sm motion-button shadow-md shadow-warm-200">
                <Plus size={16} /> Create New Plan
              </button>
            </div>
          </div>
        </div>

        {summaries.length > 1 && (
          <div className="bg-white rounded-[28px] shadow-sm border border-warm-100/30 p-6 md:p-7">
            <div className="flex items-center justify-between gap-3 mb-4">
              <div>
                <h2 className="text-xl text-warm-900 font-[family-name:var(--font-display)]">Quick Comparison</h2>
                <p className="text-sm text-warm-500 mt-1">Compare the major planning assumptions across all saved plans.</p>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[920px] text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-[0.16em] text-warm-400 border-b border-warm-100">
                    <th className="py-3 pr-4 font-semibold">Plan</th>
                    <th className="py-3 pr-4 font-semibold">People</th>
                    <th className="py-3 pr-4 font-semibold">Retire</th>
                    <th className="py-3 pr-4 font-semibold">Horizon</th>
                    <th className="py-3 pr-4 font-semibold">Portfolio</th>
                    <th className="py-3 pr-4 font-semibold">Income</th>
                    <th className="py-3 pr-4 font-semibold">Tax Rate</th>
                    <th className="py-3 pr-4 font-semibold">Savings</th>
                    <th className="py-3 pr-4 font-semibold">Expenses</th>
                    <th className="py-3 pr-4 font-semibold">Cash Flow</th>
                  </tr>
                </thead>
                <tbody>
                  {summaries.map(summary => (
                    <tr key={summary.id} className={`border-b border-warm-50 ${summary.id === activePlanId ? 'bg-warm-50/50' : ''}`}>
                      <td className="py-3 pr-4 font-semibold text-warm-800">{summary.name}</td>
                      <td className="py-3 pr-4 text-warm-500">{summary.hasSpouse ? `${summary.myName} + ${summary.spouseName || 'Partner'}` : summary.myName}</td>
                      <td className="py-3 pr-4 text-warm-700">{summary.retirementLabel}</td>
                      <td className="py-3 pr-4 text-warm-700">to {summary.planToAge} ({summary.planningYearsRemaining} yrs)</td>
                      <td className="py-3 pr-4 text-warm-700">{formatCurrencyFull(summary.currentSavings)}</td>
                      <td className="py-3 pr-4 text-warm-700">{formatCurrencyFull(summary.annualIncome)}/yr</td>
                      <td className="py-3 pr-4 text-warm-700">{summary.effectiveTaxRate.toFixed(1)}%</td>
                      <td className="py-3 pr-4 text-warm-700">{formatCurrencyFull(summary.annualContribution)}/yr</td>
                      <td className="py-3 pr-4 text-warm-700">{formatCurrency(Math.round(summary.currentMonthlyExpenses))}/mo</td>
                      <td className={`py-3 pr-4 font-semibold ${summary.cashFlow >= 0 ? 'text-sage-700' : 'text-coral'}`}>{summary.cashFlow >= 0 ? '+' : ''}{formatCurrency(summary.cashFlow)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
          {summaries.map(summary => (
            <PlanComparisonCard
              key={summary.id}
              summary={summary}
              isActive={summary.id === activePlanId}
              onOpen={() => onLoadPlan(plans.find(plan => plan.id === summary.id))}
              onDuplicate={() => onDuplicatePlan(plans.find(plan => plan.id === summary.id))}
              onDelete={() => onDeletePlan(summary.id)}
              onRename={(newName) => onRenamePlan(summary.id, newName)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function DashboardPlanComparison({ plans, activePlanId, onLoadPlan, onOpenPlans }) {
  const summaries = plans.map(plan => getPlanSummary(plan)).filter(Boolean);
  if (summaries.length <= 1) return null;

  return (
    <div className="bg-white rounded-[28px] shadow-sm border border-warm-100/30 p-5 md:p-6">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 mb-4">
        <div>
          <h2 className="text-xl text-warm-900 font-[family-name:var(--font-display)]">Plan Comparison</h2>
          <p className="text-sm text-warm-500 mt-1">You have {summaries.length} saved plans. Compare them here or open the full plans page.</p>
        </div>
        <button onClick={onOpenPlans} className="self-start md:self-auto px-4 py-2 rounded-xl bg-warm-50 text-warm-700 text-sm font-semibold motion-button">
          Open Plans Page
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
        {summaries.map(summary => (
          <button
            key={summary.id}
            onClick={() => onLoadPlan(plans.find(plan => plan.id === summary.id))}
            className={`text-left rounded-2xl border p-4 surface-hover motion-button ${summary.id === activePlanId ? 'border-warm-300 bg-warm-50/70' : 'border-warm-100 bg-white'}`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-warm-800">{summary.name}</span>
              {summary.id === activePlanId && <span className="text-[10px] uppercase tracking-[0.16em] text-warm-600">Active</span>}
            </div>
            <div className="text-xs text-warm-400 mt-1">{summary.retirementLabel} · {summary.locationLabel}</div>
            <div className="mt-3 space-y-1 text-sm">
              <div className="flex justify-between"><span className="text-warm-400">Portfolio</span><span className="font-semibold text-warm-700">{formatCurrencyFull(summary.currentSavings)}</span></div>
              <div className="flex justify-between"><span className="text-warm-400">Income</span><span className="font-semibold text-warm-700">{formatCurrency(summary.annualIncome)}</span></div>
              <div className="flex justify-between"><span className="text-warm-400">Expenses</span><span className="font-semibold text-warm-700">{formatCurrency(Math.round(summary.currentMonthlyExpenses))}/mo</span></div>
              <div className="flex justify-between"><span className="text-warm-400">Tax rate</span><span className="font-semibold text-warm-700">{summary.effectiveTaxRate.toFixed(1)}%</span></div>
              <div className="flex justify-between"><span className="text-warm-400">Cash flow</span><span className={`font-semibold ${summary.cashFlow >= 0 ? 'text-sage-700' : 'text-coral'}`}>{summary.cashFlow >= 0 ? '+' : ''}{formatCurrency(summary.cashFlow)}</span></div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── APP ROOT ───────────────────────────────────────────────

// ─── PLAN MANAGER ───────────────────────────────────────────

export default function App() {
  const [setupComplete, setSetupComplete] = useState(false);
  const [initialData, setInitialData] = useState(null);
  const [plans, setPlans] = useState([]);
  const [activePlanId, setActivePlanId] = useState(null);
  const [showPlanManager, setShowPlanManager] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [planDraftName, setPlanDraftName] = useState('');
  const [vaultMode, setVaultMode] = useState('checking');
  const [vaultConfig, setVaultConfig] = useState(null);
  const [vaultPayload, setVaultPayload] = useState(null);
  const [vaultKey, setVaultKey] = useState(null);
  const [vaultError, setVaultError] = useState('');
  const [vaultBusy, setVaultBusy] = useState(false);
  const [migrationPlans, setMigrationPlans] = useState([]);

  const persistEncryptedPlans = useCallback(async (nextPlans, nextVaultKey = vaultKey, nextVaultConfig = vaultConfig) => {
    if (!nextVaultKey || !nextVaultConfig) return;
    const encrypted = await encryptPlansPayload(nextPlans, nextVaultKey, nextVaultConfig);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(encrypted));
    setVaultPayload(encrypted);
  }, [vaultConfig, vaultKey]);

  useEffect(() => {
    if (!globalThis.crypto?.subtle) {
      setVaultError('This browser does not support the Web Crypto features required for encrypted local storage.');
      setVaultMode('setup');
      return;
    }

    const stored = readStoredVault();
    if (stored.type === 'encrypted') {
      setVaultPayload(stored.payload);
      setVaultConfig({ version: stored.payload.version, iterations: stored.payload.iterations || VAULT_ITERATIONS, salt: stored.payload.salt });
      setVaultMode('unlock');
      return;
    }

    if (stored.type === 'legacy') {
      setMigrationPlans(stored.plans);
      setPlans(stored.plans);
      setVaultMode('setup');
      setVaultError('');
      return;
    }

    if (stored.type === 'corrupt') {
      setVaultError('Stored local data could not be read. You can reset this device data and create a new encrypted vault.');
    }

    setVaultMode('setup');
  }, []);

  const activePlan = plans.find(p => p.id === activePlanId);

  const resetVault = useCallback(() => {
    if (!window.confirm('This will permanently remove all saved plans from this browser. Continue?')) return;
    localStorage.removeItem(STORAGE_KEY);
    setVaultPayload(null);
    setVaultConfig(null);
    setVaultKey(null);
    setVaultError('');
    setVaultBusy(false);
    setMigrationPlans([]);
    setPlans([]);
    setSetupComplete(false);
    setInitialData(null);
    setActivePlanId(null);
    setShowPlanManager(false);
    setShowOnboarding(false);
    setPlanDraftName('');
    setVaultMode('setup');
  }, []);

  const unlockVault = useCallback(async (passphrase) => {
    if (!vaultPayload) return;
    setVaultBusy(true);
    setVaultError('');
    try {
      const nextVaultConfig = { version: vaultPayload.version, iterations: vaultPayload.iterations || VAULT_ITERATIONS, salt: vaultPayload.salt };
      const nextVaultKey = await deriveVaultKey(passphrase, nextVaultConfig.salt, nextVaultConfig.iterations);
      const decryptedPlans = await decryptPlansPayload(vaultPayload, nextVaultKey);
      setVaultKey(nextVaultKey);
      setVaultConfig(nextVaultConfig);
      setPlans(decryptedPlans);
      setVaultMode('ready');
      setShowPlanManager(decryptedPlans.length > 0);
    } catch {
      setVaultError('Passphrase was incorrect or the stored vault could not be decrypted.');
    } finally {
      setVaultBusy(false);
    }
  }, [vaultPayload]);

  const setupVault = useCallback(async (passphrase) => {
    setVaultBusy(true);
    setVaultError('');
    try {
      const nextVaultConfig = createVaultConfig();
      const nextVaultKey = await deriveVaultKey(passphrase, nextVaultConfig.salt, nextVaultConfig.iterations);
      const seedPlans = migrationPlans.length > 0 ? migrationPlans : [];
      const encrypted = await encryptPlansPayload(seedPlans, nextVaultKey, nextVaultConfig);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(encrypted));
      setVaultPayload(encrypted);
      setVaultConfig(nextVaultConfig);
      setVaultKey(nextVaultKey);
      setPlans(seedPlans);
      setMigrationPlans([]);
      setVaultMode('ready');
      setShowPlanManager(seedPlans.length > 0);
    } catch {
      setVaultError('Could not create the encrypted vault in this browser.');
    } finally {
      setVaultBusy(false);
    }
  }, [migrationPlans]);

  const lockVault = useCallback(() => {
    setVaultKey(null);
    setPlans([]);
    setSetupComplete(false);
    setInitialData(null);
    setActivePlanId(null);
    setShowPlanManager(false);
    setShowOnboarding(false);
    setPlanDraftName('');
    setVaultError('');
    setVaultMode(vaultPayload ? 'unlock' : 'setup');
  }, [vaultPayload]);

  const exportEncryptedPlan = useCallback(async (plan) => {
    if (!vaultKey || !vaultConfig || !plan) return;
    try {
      const encrypted = await encryptPlansPayload([plan], vaultKey, vaultConfig);
      downloadJsonFile(
        {
          ...encrypted,
          exportType: 'retirement-planner-plan-backup',
          exportedAt: new Date().toISOString(),
        },
        `${sanitizeFilename(plan.name)}-encrypted-backup-${new Date().toISOString().slice(0, 10)}.json`
      );
    } catch {
      setVaultError('Could not generate an encrypted backup for this plan.');
    }
  }, [vaultConfig, vaultKey]);

  const importEncryptedBackup = useCallback(async (file) => {
    if (!vaultKey || !vaultConfig || !file) return;
    const passphrase = window.prompt('Enter the passphrase used when this backup file was created.');
    if (!passphrase?.trim()) return;

    setVaultBusy(true);
    setVaultError('');
    try {
      const raw = await file.text();
      const parsed = JSON.parse(raw);
      if (!parsed?.salt || !parsed?.iv || !parsed?.ciphertext) {
        throw new Error('Invalid backup file');
      }

      const importKey = await deriveVaultKey(passphrase.trim(), parsed.salt, parsed.iterations || VAULT_ITERATIONS);
      const importedPlans = await decryptPlansPayload(parsed, importKey);
      if (importedPlans.length === 0) {
        throw new Error('No plans found');
      }

      const preparedPlans = importedPlans.map((plan, index) => uniquifyImportedPlan(plan, [...plans, ...importedPlans.slice(0, index)], index));
      const updatedPlans = [...plans, ...preparedPlans];
      setPlans(updatedPlans);
      await persistEncryptedPlans(updatedPlans);

      if (plans.length === 0 && preparedPlans[0]) {
        loadPlan(preparedPlans[0]);
      } else {
        setShowPlanManager(true);
      }
    } catch {
      setVaultError('Could not import that backup. Make sure it is an encrypted backup file and that the passphrase is correct.');
    } finally {
      setVaultBusy(false);
    }
  }, [loadPlan, persistEncryptedPlans, plans, vaultConfig, vaultKey]);

  const handleSave = useCallback((state) => {
    if (!activePlanId || !vaultKey || !vaultConfig) return;
    setPlans(prev => {
      const updated = prev.map(p => p.id === activePlanId ? { ...p, state, updatedAt: Date.now() } : p);
      void persistEncryptedPlans(updated);
      return updated;
    });
  }, [activePlanId, persistEncryptedPlans, vaultConfig, vaultKey]);

  const createPlan = (data, name) => {
    const plan = { id: Date.now(), name: name || `Plan ${plans.length + 1}`, initialData: data, state: null, createdAt: Date.now(), updatedAt: Date.now() };
    const updated = [...plans, plan];
    setPlans(updated);
    void persistEncryptedPlans(updated);
    setActivePlanId(plan.id);
    setInitialData(data);
    setSetupComplete(true);
    setShowPlanManager(false);
    setShowOnboarding(false);
    setPlanDraftName('');
  };

  function loadPlan(plan) {
    setActivePlanId(plan.id);
    setInitialData(plan.initialData);
    setSetupComplete(true);
    setShowPlanManager(false);
    setShowOnboarding(false);
  }

  const deletePlan = (id) => {
    const updated = plans.filter(p => p.id !== id);
    setPlans(updated);
    void persistEncryptedPlans(updated);
    if (activePlanId === id) { setActivePlanId(null); setSetupComplete(false); }
    if (updated.length === 0) {
      setShowPlanManager(false);
      setShowOnboarding(false);
      setPlanDraftName('');
    }
  };

  const duplicatePlan = (plan) => {
    const copy = { ...plan, id: Date.now(), name: plan.name + ' (copy)', createdAt: Date.now() };
    const updated = [...plans, copy];
    setPlans(updated);
    void persistEncryptedPlans(updated);
  };

  const renamePlan = (id, newName) => {
    const trimmedName = newName.trim();
    if (!trimmedName) return;
    setPlans(prev => {
      const updated = prev.map(plan => plan.id === id ? { ...plan, name: trimmedName, updatedAt: Date.now() } : plan);
      void persistEncryptedPlans(updated);
      return updated;
    });
  };

  const openCreatePlanFlow = () => {
    setPlanDraftName(`Plan ${plans.length + 1}`);
    setShowPlanManager(false);
    setShowOnboarding(false);
    setSetupComplete(false);
  };

  if (vaultMode === 'checking') {
    return (
      <div className="min-h-screen bg-cream flex items-center justify-center p-4 text-warm-600">
        <div className="rounded-3xl bg-white border border-warm-100/30 shadow-lg shadow-warm-100/40 px-8 py-6 text-center">
          Unlocking secure storage...
        </div>
      </div>
    );
  }

  if (vaultMode === 'setup' || vaultMode === 'unlock') {
    return (
      <VaultAccessScreen
        mode={vaultMode}
        onSetup={setupVault}
        onUnlock={unlockVault}
        onReset={resetVault}
        busy={vaultBusy}
        error={vaultError}
        hasMigratingPlans={migrationPlans.length > 0}
      />
    );
  }

  if (showPlanManager && plans.length > 0) {
    return (
      <PlansPage
        plans={plans}
        activePlanId={activePlanId}
        onLoadPlan={loadPlan}
        onDuplicatePlan={duplicatePlan}
        onDeletePlan={deletePlan}
        onRenamePlan={renamePlan}
        onCreateNewPlan={openCreatePlanFlow}
        onClose={() => setShowPlanManager(false)}
        allowClose={setupComplete}
        onImportBackup={importEncryptedBackup}
      />
    );
  }

  if (!setupComplete) {
    if (!showOnboarding) {
      return (
        <PlanSetupScreen
          planName={planDraftName}
          setPlanName={setPlanDraftName}
          onContinue={() => setShowOnboarding(true)}
          onBack={() => setShowPlanManager(true)}
          hasExistingPlans={plans.length > 0}
          onImportBackup={importEncryptedBackup}
        />
      );
    }

    return <OnboardingWizard planName={planDraftName.trim() || `Plan ${plans.length + 1}`} onComplete={(data) => createPlan(data, planDraftName.trim())} />;
  }

  return <Dashboard initialData={initialData} onSave={handleSave} savedState={activePlan?.state} plans={plans} activePlanId={activePlanId} activePlanName={activePlan?.name || 'Current Plan'} onOpenPlans={() => setShowPlanManager(true)} onLoadPlan={loadPlan} onLockVault={lockVault} onExportEncrypted={exportEncryptedPlan} key={activePlanId} />;
}
