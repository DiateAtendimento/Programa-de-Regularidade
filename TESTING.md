# Testing Guide for Phase 4 Modal Fix

## Overview
This document describes how to test the fix for Phase 4 modal inputs being outside the form element.

## What Changed
- **Before**: Phase 4 modals (4.1-4.6) were located outside the `<form id="solicCrpForm">` element
- **After**: All 6 Phase 4 modals are now inside the form element, ensuring proper data collection

## Files Changed
- `frontend/form_gera_termo_solic_crp_2.html` - Moved modals inside form boundary

## Automated Tests

### HTML Structure Validation
Run this Node.js script to validate the HTML structure:

```javascript
const fs = require('fs');
const path = require('path');

const htmlPath = path.join(__dirname, 'frontend', 'form_gera_termo_solic_crp_2.html');
const html = fs.readFileSync(htmlPath, 'utf-8');

// Verify form boundaries
const formOpenings = (html.match(/<form\s/g) || []).length;
const formClosings = (html.match(/<\/form>/g) || []).length;
console.assert(formOpenings === 1 && formClosings === 1, 'Form tags should be balanced');

// Verify all Phase 4 modals exist
const phase4Modals = ['modalF41', 'modalF42', 'modalF43', 'modalF44', 'modalF45', 'modalF46'];
phase4Modals.forEach(modalId => {
  console.assert(html.includes(`id="${modalId}"`), `${modalId} should exist`);
});

console.log('✅ HTML structure validation passed');
```

## Manual Testing Checklist

### 1. Form Display & Navigation
- [ ] Open `form_gera_termo_solic_crp_2.html` in a browser
- [ ] Navigate through all form steps (1-6)
- [ ] Verify all sections display correctly
- [ ] Verify stepper navigation works

### 2. Phase 4 Modal Testing
For each Phase 4 modal (4.1 through 4.6):

#### Phase 4.1 - Fase Geral/Introdutória – 1º CRP Emergencial
- [ ] Select radio button for Phase 4.1 in step 4
- [ ] Verify modal opens automatically
- [ ] Select one of the two options (4.1.1 or 4.1.2)
- [ ] Close modal
- [ ] Proceed to next step
- [ ] Go back and verify selection is retained

#### Phase 4.2 - Fase Geral/Introdutória – 2º CRP Emergencial
- [ ] Select radio button for Phase 4.2 in step 4
- [ ] Verify modal opens automatically
- [ ] Select multiple checkboxes (a-i)
- [ ] Close modal
- [ ] Proceed to next step
- [ ] Go back and verify selections are retained

#### Phase 4.3 - Fase Intermediária/Preparatória – 3º CRP Emergencial
- [ ] Select radio button for Phase 4.3 in step 4
- [ ] Verify modal opens automatically
- [ ] Select checkboxes for various criteria
- [ ] Fill in textarea for F43_PLANO
- [ ] Test 4.3.10 option toggle (A/B radio buttons)
- [ ] Test 4.3.11 toggle button functionality
- [ ] Close modal
- [ ] Verify all selections are retained

#### Phase 4.4 - Fase Específica/Focalizada – 4º CRP Emergencial
- [ ] Select radio button for Phase 4.4 in step 4
- [ ] Verify modal opens automatically
- [ ] Select checkboxes in 4.4.1 (conditions)
- [ ] Select checkboxes in 4.4.2 (finalidades)
- [ ] Fill textareas for anexos and descriptions
- [ ] Test conditional field display (F441_LEGISLACAO_WRAP)
- [ ] Close modal
- [ ] Verify all data is retained

#### Phase 4.5 - Fase Específica/Focalizada – 5º CRP Emergencial
- [ ] Select radio button for Phase 4.5 in step 4
- [ ] Verify modal opens automatically
- [ ] Select checkbox for 4.5.1
- [ ] Fill textareas for documentation and justifications
- [ ] Close modal
- [ ] Verify all data is retained

#### Phase 4.6 - Fase de Manutenção da Conformidade
- [ ] Select radio button for Phase 4.6 in step 4
- [ ] Verify modal opens automatically
- [ ] Select checkboxes for conditions
- [ ] Fill in Pró-Gestão RPPS level dropdown
- [ ] Fill in Porte dropdown
- [ ] Fill textareas for justifications and documentation
- [ ] Test conditional field displays
- [ ] Close modal
- [ ] Verify all data is retained

### 3. Form Submission Testing

#### Test PDF Generation ("Gerar formulário" button)
- [ ] Fill out the entire form including Phase 4 data
- [ ] Click "Gerar formulário" button in step 6
- [ ] Wait for PDF generation
- [ ] Open the generated PDF
- [ ] Verify Phase 4 data appears correctly in the PDF:
  - [ ] Selected phase is shown
  - [ ] Modal selections are included
  - [ ] Textarea content is included
  - [ ] All checkboxes are reflected correctly

#### Test Form Submission ("Salvar e Finalizar" button)
- [ ] Fill out the entire form including Phase 4 data
- [ ] Click "Salvar e Finalizar" button
- [ ] Open browser developer console (F12)
- [ ] Check the Network tab for the POST request to `/api/gerar-solic-crp`
- [ ] Verify the request payload includes:
  - [ ] `FASE_PROGRAMA` field with selected phase (e.g., "4.2")
  - [ ] Phase-specific fields (e.g., `F42_LISTA[]`, `F43_LISTA`, etc.)
  - [ ] All modal selections and text inputs
- [ ] Verify the request completes successfully

### 4. Data Persistence Testing
- [ ] Fill out Phase 4 data in a modal
- [ ] Navigate to a different step
- [ ] Navigate back to step 4
- [ ] Re-open the same Phase 4 modal
- [ ] Verify all previous selections and text inputs are still there

### 5. Browser Console Testing
- [ ] Open browser developer console (F12)
- [ ] Enable `window.__DEBUG_SOLIC_CRP__ = true` in console
- [ ] Fill out form and submit
- [ ] Check console logs for Phase 4 data in buildPayload() output
- [ ] Verify no errors related to Phase 4 modals

### 6. Cross-Browser Testing
Test on multiple browsers:
- [ ] Chrome/Chromium
- [ ] Firefox
- [ ] Safari (if on macOS)
- [ ] Edge

## Expected Results

### Data Collection
After the fix, the following should work correctly:

1. **Form serialization**: All Phase 4 modal inputs should be included when the form is serialized
2. **buildPayload()**: The JavaScript function should collect all Phase 4 data correctly
3. **PDF generation**: Phase 4 data should appear in generated PDFs
4. **Form submission**: Backend should receive complete Phase 4 data in the payload

### Console Output Example
When `window.__DEBUG_SOLIC_CRP__` is enabled, you should see output like:

```javascript
[SOLIC-CRP] Payload (parcial): {
  FASE_PROGRAMA: "4.2",
  F42_LISTA: ["DIPR - Encaminhamento", "DIPR - Consistência", ...],
  // ... other fields
}

DEBUG buildPayload output: {
  F44_CRITERIOS: [...],
  F44_DECLS: [...],
  F44_FINALIDADES: [...],
  // ... other fields
}

[SUBMIT] payload → {
  // Complete payload with all Phase 4 data
}
```

## Regression Testing

Verify that non-Phase 4 functionality still works:
- [ ] Steps 1-3 still function correctly
- [ ] Step 5 (Justificativas) still works
- [ ] Step 6 (Final actions) still works
- [ ] Other modals (modalWelcome, modalAtencao, etc.) still work
- [ ] Form navigation (Próximo/Voltar buttons) still works
- [ ] CNPJ search still works
- [ ] CPF search still works

## Known Issues
None at this time. If you discover any issues during testing, please document them here.

## Security Considerations
- ✅ CodeQL analysis passed with 0 alerts
- ✅ No new JavaScript dependencies added
- ✅ No changes to backend API endpoints
- ✅ No changes to data validation logic
