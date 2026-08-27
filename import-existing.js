// Run this in the browser console after opening index.html to import existing budget data
// Paste: const s = document.createElement('script'); s.src = 'import-existing.js'; document.head.appendChild(s);

(function importExistingData() {
  const data = {
    categories: [
      { name: 'Housing', items: ['Mortgage/Rent', 'Phone', 'Electricity', 'Gas', 'Waste Management', 'Water & Sewage', 'HOA', 'Cable/Internet', 'Security'] },
      { name: 'Transportation', items: ['Car Insurance', 'Licensing', 'Fuel', 'Maintenance', 'Toll'] },
      { name: 'Insurance', items: ['Medical (Family)', 'Pet Insurance'] },
      { name: 'Food', items: ['Costco', 'Groceries', 'Butcher', 'T&T', 'Box of Good'] },
      { name: 'Pets', items: ['Supplies'] },
      { name: 'Personal Care', items: ['Medical', 'Hair/Nails', 'Clothing'] },
      { name: 'Misc', items: ['Weekend Fun', 'Buffer'] },
      { name: 'Loans/Debt', items: ['Credit Card (Chase)', 'Credit Card (First Tech)'] },
      { name: 'Taxes', items: ['Federal', 'State', 'Local', 'Other'] },
      { name: 'Subscriptions', items: ['YouTube Premium', 'Amazon', 'Newsgroup Ninja', '1Password'] },
      { name: 'Other', items: ['ZepBound', 'Sheppard Allowance'] }
    ],
    settings: { earners: ['Cory', 'Sara'] },
    months: {}
  };

  function id() { return crypto.randomUUID(); }

  // Helper: create expense with paycheck split
  function exp(category, name, pc1Amt, pc2Amt, actual, method, p1Id, p2Id) {
    const paycheckAmounts = {};
    if (pc1Amt) paycheckAmounts[p1Id] = pc1Amt;
    if (pc2Amt) paycheckAmounts[p2Id] = pc2Amt;
    return { id: id(), category, name, paycheckAmounts, actual: actual || 0, paymentMethod: method || 'bank' };
  }

  // ---- JANUARY 2026 ----
  const j1 = id(), j2 = id();
  data.months['2026-01'] = {
    paychecks: [
      { id: j1, earner: 'Cory', amount: 4921, date: '2026-01-15' },
      { id: j2, earner: 'Sara', amount: 3333, date: '2026-01-31' }
    ],
    expenses: [
      exp('Housing', 'Mortgage/Rent',     1447, 1447, 2894, 'bank', j1, j2),
      exp('Housing', 'Phone',             0,    161,  161,  'bank', j1, j2),
      exp('Housing', 'Electricity',        0,    232,  232,  'bank', j1, j2),
      exp('Housing', 'Gas',               7,    0,    7,    'bank', j1, j2),
      exp('Housing', 'Waste Management',   0,    125,  125,  'bank', j1, j2),
      exp('Housing', 'HOA',               78,   0,    78,   'bank', j1, j2),
      exp('Housing', 'Cable/Internet',     0,    86,   86,   'bank', j1, j2),
      exp('Transportation', 'Fuel',        120,  120,  240,  'bank', j1, j2),
      exp('Insurance', 'Pet Insurance',    116,  0,    116,  'bank', j1, j2),
      exp('Food', 'Costco',               0,    260,  260,  'bank', j1, j2),
      exp('Food', 'Groceries',            260,  360,  620,  'bank', j1, j2),
      exp('Food', 'Box of Good',          0,    60,   60,   'bank', j1, j2),
      exp('Pets', 'Supplies',             27,   40,   67,   'bank', j1, j2),
      exp('Misc', 'Weekend Fun',          200,  200,  400,  'bank', j1, j2),
      exp('Misc', 'Buffer',              113,  100,  213,  'bank', j1, j2),
      exp('Loans/Debt', 'Credit Card (Chase)', 882, 66, 948, 'bank', j1, j2),
      exp('Loans/Debt', 'Credit Card (First Tech)', 229, 76, 305, 'bank', j1, j2),
      exp('Subscriptions', 'YouTube Premium', 17, 0, 17, 'credit_card', j1, j2),
      exp('Subscriptions', 'Costco Membership', 130, 0, 130, 'credit_card', j1, j2),
      exp('Subscriptions', 'Newsgroup Ninja', 70, 0, 70, 'credit_card', j1, j2),
      exp('Subscriptions', '1Password',    65,  0,    65,   'credit_card', j1, j2),
      exp('Other', 'ZepBound',            600,  0,    600,  'bank', j1, j2),
      exp('Other', 'Sheppard Allowance',  60,   0,    60,   'bank', j1, j2),
    ],
    allocations: { savings: 500, credit_card_debt: 0, investments: 0 }
  };

  // ---- FEBRUARY 2026 ----
  const f1 = id(), f2 = id();
  data.months['2026-02'] = {
    paychecks: [
      { id: f1, earner: 'Cory', amount: 3392, date: '2026-02-15' },
      { id: f2, earner: 'Sara', amount: 3415.87, date: '2026-02-28' }
    ],
    expenses: [
      exp('Housing', 'Mortgage/Rent',     1447, 1447,   2894,   'bank', f1, f2),
      exp('Housing', 'Phone',             0,    106,    106,    'bank', f1, f2),
      exp('Housing', 'Electricity',        0,    207,    207,    'bank', f1, f2),
      exp('Housing', 'Gas',               7,    0,      7,      'bank', f1, f2),
      exp('Housing', 'Waste Management',   0,    125.51, 125.51, 'bank', f1, f2),
      exp('Housing', 'Water & Sewage',     0,    198.15, 198.15, 'bank', f1, f2),
      exp('Housing', 'HOA',               78,   0,      78,     'bank', f1, f2),
      exp('Housing', 'Cable/Internet',     0,    86,     86,     'bank', f1, f2),
      exp('Transportation', 'Fuel',        120,  120,    240,    'bank', f1, f2),
      exp('Insurance', 'Pet Insurance',    116,  0,      116,    'bank', f1, f2),
      exp('Food', 'Costco',               0,    260,    260,    'bank', f1, f2),
      exp('Food', 'Groceries',            380,  380,    760,    'bank', f1, f2),
      exp('Food', 'Butcher',              200,  0,      200,    'bank', f1, f2),
      exp('Pets', 'Supplies',             150,  150,    300,    'bank', f1, f2),
      exp('Misc', 'Weekend Fun',          200,  200,    400,    'bank', f1, f2),
      exp('Misc', 'Buffer',              113,  100,    213,    'bank', f1, f2),
      exp('Loans/Debt', 'Credit Card (Chase)', 0, 32.21, 32.21, 'bank', f1, f2),
      exp('Subscriptions', 'YouTube Premium', 17, 0,    17,     'credit_card', f1, f2),
      exp('Other', 'ZepBound',            500,  0,      500,    'bank', f1, f2),
      exp('Other', 'Sheppard Allowance',  60,   0,      60,     'bank', f1, f2),
    ],
    allocations: { savings: 0, credit_card_debt: 0, investments: 0 }
  };

  // ---- MARCH 2026 ----
  const m1 = id(), m2 = id();
  data.months['2026-03'] = {
    paychecks: [
      { id: m1, earner: 'Cory', amount: 3392, date: '2026-03-15' },
      { id: m2, earner: 'Sara', amount: 4120, date: '2026-03-31' }
    ],
    expenses: [
      exp('Housing', 'Mortgage/Rent',     1447, 1447,  2894, 'bank', m1, m2),
      exp('Housing', 'Phone',             0,    104,   104,  'bank', m1, m2),
      exp('Housing', 'Electricity',        0,    221,   221,  'bank', m1, m2),
      exp('Housing', 'Gas',               7,    0,     7,    'bank', m1, m2),
      exp('Housing', 'Waste Management',   0,    2,     2,    'bank', m1, m2),
      exp('Housing', 'HOA',               78,   0,     78,   'bank', m1, m2),
      exp('Housing', 'Cable/Internet',     0,    108,   108,  'bank', m1, m2),
      exp('Transportation', 'Fuel',        120,  120,   240,  'bank', m1, m2),
      exp('Insurance', 'Pet Insurance',    116,  0,     116,  'bank', m1, m2),
      exp('Food', 'Costco',               180,  180,   360,  'bank', m1, m2),
      exp('Food', 'Groceries',            380,  380,   760,  'bank', m1, m2),
      exp('Food', 'Butcher',              80,   0,     80,   'bank', m1, m2),
      exp('Pets', 'Supplies',             150,  40,    190,  'bank', m1, m2),
      exp('Misc', 'Weekend Fun',          200,  200,   400,  'bank', m1, m2),
      exp('Misc', 'Buffer',              14,   100,   114,  'bank', m1, m2),
      exp('Loans/Debt', 'Credit Card (Chase)', 43, 1101, 1144, 'bank', m1, m2),
      exp('Subscriptions', 'YouTube Premium', 17, 0,   17,   'credit_card', m1, m2),
      exp('Subscriptions', 'Amazon',       0,    117,   117,  'credit_card', m1, m2),
      exp('Other', 'ZepBound',            500,  0,     500,  'bank', m1, m2),
      exp('Other', 'Sheppard Allowance',  60,   0,     60,   'bank', m1, m2),
    ],
    allocations: { savings: 0, credit_card_debt: 0, investments: 0 }
  };

  localStorage.setItem('zeroBudget_data', JSON.stringify(data));
  console.log('Budget data imported (Jan-Mar 2026 with paycheck splits)');
  alert('Budget data imported! Page will reload.');
  location.reload();
})();
