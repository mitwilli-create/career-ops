const HARD_EXPIRED_PATTERNS = [
  /job (is )?no longer available/i,
  /job.*no longer open/i,
  /position has been filled/i,
  /this job has expired/i,
  /job posting has expired/i,
  /no longer accepting applications/i,
  /this (position|role|job) (is )?no longer/i,
  /this job (listing )?is closed/i,
  /job (listing )?not found/i,
  /the page you are looking for doesn.t exist/i,
  /applications?\s+(?:(?:have|are|is)\s+)?closed/i,
  /closed on \d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i,
  /closed on (?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{1,2}/i,
  /diese stelle (ist )?(nicht mehr|bereits) besetzt/i,
  /offre (expirée|n'est plus disponible)/i,
];

const LISTING_PAGE_PATTERNS = [
  /\d+\s+jobs?\s+found/i,
  /search for jobs page is loaded/i,
];

const EXPIRED_URL_PATTERNS = [
  /[?&]error=true/i,
];

const APPLY_PATTERNS = [
  /\bapply\b/i,
  /\bsolicitar\b/i,
  /\bbewerben\b/i,
  /\bpostuler\b/i,
  /submit application/i,
  /easy apply/i,
  /start application/i,
  /ich bewerbe mich/i,
];

const MIN_CONTENT_CHARS = 300;

// ── Per-ATS host-aware detection (Phase 2.2, 2026-05-22) ─────────────────────
// When finalUrl resolves to a known ATS host, prefer the ATS-specific closed
// patterns over the generic HARD_EXPIRED_PATTERNS. ATS-specific patterns are
// higher confidence + reduce false positives from generic phrases.

const ATS_HOSTS = {
  linkedin:        ['linkedin.com', 'www.linkedin.com'],
  greenhouse:      ['greenhouse.io', 'job-boards.greenhouse.io', 'boards.greenhouse.io'],
  ashby:           ['ashbyhq.com', 'jobs.ashbyhq.com'],
  lever:           ['lever.co', 'jobs.lever.co'],
  workday:         ['workday.com', 'myworkdayjobs.com'],
  eightfold:       ['eightfold.ai', 'careers.eightfold.ai'],
  jobvite:         ['jobvite.com', 'jobs.jobvite.com'],
  smartrecruiters: ['smartrecruiters.com', 'careers.smartrecruiters.com'],
  icims:           ['icims.com'],
  taleo:           ['taleo.net'],
};

const ATS_CLOSED_PATTERNS = {
  linkedin: [
    /no longer accepting applications/i,
    /this job is no longer available/i,
    /this job posting is no longer/i,
  ],
  greenhouse: [
    /the page you are looking for could not be found/i,
    /this position is no longer available/i,
    /job not found/i,
  ],
  ashby: [
    /the role you are looking for/i,
    /this role is no longer/i,
    /position no longer accepting/i,
  ],
  lever: [
    /we'?re sorry,?\s+this role is no longer/i,
    /this opportunity is no longer available/i,
    /this position is no longer/i,
  ],
  workday: [
    /this job is no longer posted/i,
    /this requisition is no longer/i,
    /this position has been closed/i,
  ],
  eightfold: [
    /this position is no longer available/i,
    /requisition is closed/i,
  ],
  jobvite: [
    /this position is no longer/i,
  ],
  smartrecruiters: [
    /this opportunity has been closed/i,
    /this position is no longer/i,
  ],
  icims: [
    /this job is no longer available/i,
    /the job you are trying to reach/i,
  ],
  taleo: [
    /the requisition you are trying to access/i,
    /this requisition is no longer/i,
  ],
};

function detectAtsHost(finalUrl) {
  try {
    const h = new URL(finalUrl).hostname.toLowerCase();
    for (const [ats, hosts] of Object.entries(ATS_HOSTS)) {
      if (hosts.some((host) => h === host || h.endsWith('.' + host))) return ats;
    }
  } catch { /* invalid URL */ }
  return null;
}

function firstMatch(patterns, text = '') {
  return patterns.find((pattern) => pattern.test(text));
}

function hasApplyControl(controls = []) {
  return controls.some((control) => APPLY_PATTERNS.some((pattern) => pattern.test(control)));
}

export function classifyLiveness({ status = 0, finalUrl = '', bodyText = '', applyControls = [] } = {}) {
  if (status === 404 || status === 410) {
    return { result: 'expired', reason: `HTTP ${status}` };
  }

  const expiredUrl = firstMatch(EXPIRED_URL_PATTERNS, finalUrl);
  if (expiredUrl) {
    return { result: 'expired', reason: `redirect to ${finalUrl}` };
  }

  // ATS-specific closed detection (HIGH confidence) — runs before generic patterns
  // so an ATS-tailored signal wins over a less-specific generic phrase elsewhere
  // in the body.
  const atsHost = detectAtsHost(finalUrl);
  if (atsHost && ATS_CLOSED_PATTERNS[atsHost]) {
    const atsExpired = firstMatch(ATS_CLOSED_PATTERNS[atsHost], bodyText);
    if (atsExpired) {
      return { result: 'expired', reason: `${atsHost}: ${atsExpired.source}` };
    }
  }

  const expiredBody = firstMatch(HARD_EXPIRED_PATTERNS, bodyText);
  if (expiredBody) {
    return { result: 'expired', reason: `pattern matched: ${expiredBody.source}` };
  }

  if (hasApplyControl(applyControls)) {
    return { result: 'active', reason: 'visible apply control detected' };
  }

  const listingPage = firstMatch(LISTING_PAGE_PATTERNS, bodyText);
  if (listingPage) {
    return { result: 'expired', reason: `pattern matched: ${listingPage.source}` };
  }

  if (bodyText.trim().length < MIN_CONTENT_CHARS) {
    return { result: 'expired', reason: 'insufficient content — likely nav/footer only' };
  }

  return { result: 'uncertain', reason: 'content present but no visible apply control found' };
}

// Test helpers exposed for unit tests + consumers that want host-only detection.
export { detectAtsHost, ATS_HOSTS, ATS_CLOSED_PATTERNS };
