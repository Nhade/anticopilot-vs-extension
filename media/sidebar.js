(function () {
  const vscode = acquireVsCodeApi();

  // ── State ──────────────────────────────────────────────────────────────
  let currentTab = 'task';
  let activeTask = null;
  let activeRoadmapId = null;

  // Reviews state
  let reviews = [];
  let reviewsFetched = false; // response received
  let reviewsError = null;
  let activeConcept = null;
  let practiceTask = null;
  let practiceLoading = false;
  let practiceError = null;
  let solutionRevealed = false;
  let gradingConceptId = null;
  let gradeSuccess = false;
  let gradeError = null;
  let chosenGrade = null; // GRADES entry picked for the current drill

  // Roadmap state
  let roadmap = null;
  let roadmapRequested = false;
  let roadmapFetched = false;
  let roadmapError = null;
  let expandedMilestones = new Set();
  let generatingSkillpaths = new Set();
  let roadmapGenerateErrors = {}; // skillpathId -> error message

  // Task-tab generation state
  let contentGenerating = false;
  let contentError = null;
  // Per-problem UI state on the task tab
  let hintsRevealed = {}; // contentId -> count of hints revealed so far
  let promptExpanded = {}; // contentId -> long prompt expanded
  let submittingContent = {}; // contentId -> true while a submission is in flight
  let submissionResults = {}; // contentId -> { success, result, error }
  let completingTask = false;
  let completeError = null;

  // FSRS grade definitions — tone mapping mirrors the frontend drill
  // (Again=red, Hard=orange/review, Good=green/success, Easy=teal/active).
  var GRADES = [
    { grade: 1, label: 'Again', sub: 'Forgot it', tone: 'red', cls: 'grade-again', field: 'again' },
    { grade: 2, label: 'Hard', sub: 'Struggled', tone: 'review', cls: 'grade-hard', field: 'hard' },
    { grade: 3, label: 'Good', sub: 'Recalled it', tone: 'success', cls: 'grade-good', field: 'good' },
    { grade: 4, label: 'Easy', sub: 'Instant', tone: 'active', cls: 'grade-easy', field: 'easy' },
  ];

  // ── Inline icons (lucide-style strokes) ────────────────────────────────
  // One stroke family instead of mixed emoji/unicode glyphs, so weight,
  // size, and color stay uniform across themes and fonts.
  var ICONS = {
    check: '<path d="M20 6 9 17l-5-5"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    play: '<path d="m6 4 14 8-14 8z" fill="currentColor"/>',
    bulb: '<path d="M9 18h6M10 22h4M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5.76.76 1.23 1.52 1.41 2.5"/>',
    chevDown: '<path d="m6 9 6 6 6-6"/>',
    chevUp: '<path d="m18 15-6-6-6 6"/>',
    chevRight: '<path d="m9 18 6-6-6-6"/>',
    chevLeft: '<path d="m15 18-6-6 6-6"/>',
    sparkle: '<path d="M12 3.5 13.8 9a1 1 0 0 0 .64.63l5.56 1.87-5.56 1.87a1 1 0 0 0-.64.63L12 19.5 10.2 14a1 1 0 0 0-.64-.63L4.04 11.5 9.6 9.63A1 1 0 0 0 10.2 9Z"/>',
    halfCircle: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18Z" fill="currentColor" stroke="none"/>',
  };
  function icon(name) {
    return '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[name] + '</svg>';
  }

  // ── Tab switching ──────────────────────────────────────────────────────
  document.querySelectorAll('.tab-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      switchTab(btn.getAttribute('data-tab'));
    });
  });

  function switchTab(tab) {
    currentTab = tab;
    document.querySelectorAll('.tab-btn').forEach(function (b) {
      var selected = b.getAttribute('data-tab') === tab;
      b.classList.toggle('active', selected);
      b.setAttribute('aria-selected', selected ? 'true' : 'false');
    });
    document.querySelectorAll('.panel').forEach(function (p) {
      p.classList.toggle('active', p.id === 'panel-' + tab);
    });
    if (tab === 'reviews') {
      renderReviewsTab(); // spinner on first load, cached list afterwards
      // Refetch on every entry so newly-due reviews appear; skip while a
      // practice flow is active so the response can't clobber it.
      if (!activeConcept && gradingConceptId === null) {
        vscode.postMessage({ command: 'fetchDueReviews' });
      }
    } else if (tab === 'roadmap' && !roadmapRequested) {
      roadmapRequested = true;
      renderRoadmapTab(); // shows spinner
      vscode.postMessage({ command: 'fetchRoadmap' });
    } else {
      renderCurrentPanel();
    }
    // When the user opens the Task tab and the active task has no learning
    // content cached, ask the provider to refetch the roadmap. The web side
    // may have just generated content for this skillpath; without this we
    // keep showing the empty Generate panel until the user manually retries.
    if (
      tab === 'task' &&
      activeTask &&
      (!Array.isArray(activeTask.learning_contents) || activeTask.learning_contents.length === 0)
    ) {
      vscode.postMessage({ command: 'refreshActiveTask' });
    }
  }

  function renderCurrentPanel() {
    if (currentTab === 'task') {
      renderTaskTab();
    } else if (currentTab === 'reviews') {
      renderReviewsTab();
    } else if (currentTab === 'roadmap') {
      renderRoadmapTab();
    }
  }

  // ── Message handler ────────────────────────────────────────────────────
  window.addEventListener('message', function (event) {
    var msg = event.data;
    switch (msg.command) {
      case 'updateTask': {
        // Window-focus refreshes re-post the SAME task; only reset per-task UI
        // state when the task actually changed, and leave contentGenerating to
        // 'skillpathContentResult' so an in-flight generation stays disabled.
        var sameTask = activeTask && msg.task && msg.task.skillpath_id === activeTask.skillpath_id;
        activeTask = msg.task;
        if (!sameTask) {
          contentError = null;
          hintsRevealed = {};
          promptExpanded = {};
          submittingContent = {};
          submissionResults = {};
          completeError = null;
        }
        if (msg.roadmapId && msg.roadmapId !== activeRoadmapId) {
          activeRoadmapId = msg.roadmapId;
          roadmap = null;
          roadmapRequested = false;
          roadmapFetched = false;
        }
        renderTaskTab();
        break;
      }
      case 'skillpathContentResult':
        contentGenerating = false;
        contentError = msg.success ? null : msg.error || 'Failed to generate content.';
        if (msg.skillpathId && generatingSkillpaths.has(msg.skillpathId)) {
          generatingSkillpaths.delete(msg.skillpathId);
          if (!msg.success) {
            roadmapGenerateErrors[msg.skillpathId] = msg.error || 'Failed to generate content.';
          } else {
            delete roadmapGenerateErrors[msg.skillpathId];
          }
          if (currentTab === 'roadmap') {
            renderRoadmapTab();
          }
        }
        if (currentTab === 'task') {
          renderTaskTab();
        }
        break;
      case 'switchTab':
        switchTab(msg.tab);
        break;
      case 'submissionPending':
        // Covers the command-palette path; idempotent with the button click.
        if (msg.contentId && !submittingContent[msg.contentId]) {
          submittingContent[msg.contentId] = true;
          if (currentTab === 'task') {
            renderTaskTab();
          }
        }
        break;
      case 'submissionResult': {
        delete submittingContent[msg.contentId];
        submissionResults[msg.contentId] = {
          success: !!msg.success,
          result: msg.result || null,
          error: msg.error || null,
        };
        if (currentTab === 'task') {
          renderTaskTab();
          // The verdict card can render below the fold of a long prompt —
          // bring it into view next to the sticky action bar.
          var resEl = document.getElementById('sub-' + msg.contentId);
          if (resEl && typeof resEl.scrollIntoView === 'function') {
            resEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          }
        }
        break;
      }
      case 'completeResult':
        completingTask = false;
        completeError = msg.success ? null : msg.error || 'Failed to mark the task complete.';
        if (currentTab === 'task') {
          renderTaskTab();
        }
        break;
      case 'showHint':
        showHint(msg.hint, msg.conceptName);
        break;
      case 'dueReviews':
        // A failed background refresh should not replace a good cached list.
        if (msg.error && reviews.length > 0) {
          break;
        }
        reviews = msg.reviews || [];
        reviewsError = msg.error || null;
        reviewsFetched = true;
        renderReviewsTab();
        break;
      case 'practiceTask':
        practiceLoading = false;
        practiceError = msg.error || null;
        if (!msg.error) {
          practiceTask = msg.task;
          solutionRevealed = false;
        }
        renderReviewsTab();
        break;
      case 'gradeResult':
        gradingConceptId = null;
        if (!msg.success) {
          gradeError = msg.error || 'Failed to save grade. Try again.';
          chosenGrade = null;
        }
        if (msg.success) {
          gradeSuccess = true;
          gradeError = null;
          // Remove graded concept from list and reset practice view
          reviews = reviews.filter(function (r) {
            return r.concept_id !== msg.conceptId;
          });
          setTimeout(function () {
            gradeSuccess = false;
            activeConcept = null;
            practiceTask = null;
            solutionRevealed = false;
            chosenGrade = null;
            renderReviewsTab();
          }, 1400);
        }
        renderReviewsTab();
        break;
      case 'roadmapData':
        roadmapError = msg.error || null;
        roadmap = msg.roadmap || null;
        roadmapFetched = true;
        roadmapRequested = true;
        renderRoadmapTab();
        break;
    }
  });

  // ── Task Tab ───────────────────────────────────────────────────────────
  function renderTaskTab() {
    var panel = document.getElementById('panel-task');
    if (!activeTask) {
      panel.innerHTML = [
        '<div class="empty-state">',
        '  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">',
        '    <path d="M12 8V12L15 15" stroke-linecap="round" stroke-linejoin="round"/>',
        '    <circle cx="12" cy="12" r="9"/>',
        '  </svg>',
        '  <div class="empty-title">No active task</div>',
        '  <div class="empty-sub">Select a task from the dashboard or the Roadmap tab to start working.</div>',
        '</div>',
      ].join('');
      return;
    }

    var allContents = Array.isArray(activeTask.learning_contents) ? activeTask.learning_contents : [];
    var codingProblems = allContents.filter(function (c) {
      return c.content_type === 'coding_problem';
    });

    var headerChips = ['<span class="chip chip-active">Active task</span>'];
    if (activeTask.status === 'completed') {
      headerChips.push('<span class="chip chip-success">' + icon('check') + 'Completed</span>');
    }
    if (activeTask.practice_mode) {
      headerChips.push(
        '<span class="chip chip-ai">' +
          escHtml(String(activeTask.practice_mode).replace(/_/g, ' ')) +
          '</span>'
      );
    }

    var contentHtml;
    var actionBarHtml = '';
    if (codingProblems.length > 0) {
      contentHtml = codingProblems
        .map(function (p, i) {
          return renderCodingProblem(p, i === 0);
        })
        .join('');
      actionBarHtml = renderActionBar(codingProblems[0]);
    } else if (allContents.length > 0) {
      contentHtml = [
        '<div class="empty-state">',
        '  <div class="empty-title">No coding problem yet</div>',
        '  <div class="empty-sub">This task has ' + allContents.length + ' learning ' +
          (allContents.length === 1 ? 'item' : 'items') +
          ' (articles or quizzes). Open the dashboard to view them, or regenerate to add a coding problem.</div>',
        contentError ? '<div class="error-banner">' + escHtml(contentError) + '</div>' : '',
        '  <button class="btn btn-primary"' + (contentGenerating ? ' disabled' : '') + ' data-action="generate-content">' +
          escHtml(contentGenerating ? 'Generating…' : 'Regenerate content') + '</button>',
        '</div>',
      ].join('');
    } else {
      contentHtml = [
        '<div class="empty-state">',
        '  <div class="empty-title">No learning content yet</div>',
        '  <div class="empty-sub">Generate an article, coding problem, or quiz for this task so you can start practicing.</div>',
        contentError ? '<div class="error-banner">' + escHtml(contentError) + '</div>' : '',
        '  <button class="btn btn-primary"' + (contentGenerating ? ' disabled' : '') + ' data-action="generate-content">' +
          escHtml(contentGenerating ? 'Generating…' : 'Generate learning content') + '</button>',
        '</div>',
      ].join('');
    }

    panel.innerHTML = [
      '<div class="task-header">',
      '  <div class="chip-row">' + headerChips.join('') + '</div>',
      '  <h1 class="title">' + escHtml(activeTask.title) + '</h1>',
      '</div>',
      contentHtml,
      actionBarHtml,
    ].join('');
  }

  var DIFFICULTY_CHIP = { easy: 'chip-success', medium: 'chip-review', hard: 'chip-red' };

  function renderCodingProblem(problem, isPrimary) {
    var chips = ['<span class="chip chip-neutral">Coding</span>'];
    if (problem.difficulty) {
      chips.push(
        '<span class="chip ' + (DIFFICULTY_CHIP[problem.difficulty] || 'chip-neutral') + '">' +
          escHtml(problem.difficulty) + '</span>'
      );
    }

    var promptHtml = '';
    if (problem.prompt) {
      // Long prompts collapse behind a fade so the actions stay reachable.
      var isLong = problem.prompt.length > 600;
      var expanded = !!promptExpanded[problem.content_id];
      promptHtml =
        '<div class="section-label">What you\'ll build</div>' +
        '<div class="prompt-wrap' + (isLong && !expanded ? ' clipped' : '') + '">' +
        '<div class="md">' + renderMarkdown(problem.prompt) + '</div>' +
        '</div>' +
        (isLong
          ? '<button class="text-btn prompt-toggle" data-action="toggle-prompt" data-id="' +
            escAttr(problem.content_id) + '">' +
            (expanded ? 'Show less' + icon('chevUp') : 'Show full problem' + icon('chevDown')) + '</button>'
          : '');
    }

    var expected = problem.expected_output
      ? '<div class="expected-block"><div class="section-label">Expected output</div>' +
        '<div class="md">' + renderMarkdown(problem.expected_output) + '</div></div>'
      : '';

    // Secondary problems (rare) get inline actions; the first problem's
    // actions live in the sticky bar.
    var inlineActions = '';
    if (!isPrimary) {
      var isSubmitting = !!submittingContent[problem.content_id];
      inlineActions =
        '<div class="inline-actions">' +
        (problem.starter_code
          ? '<button class="btn btn-quiet" data-action="open-problem" data-id="' +
            escAttr(problem.content_id) + '">' + icon('play') + 'Open starter code</button>'
          : '') +
        '<button class="btn btn-primary"' + (isSubmitting ? ' disabled' : '') +
        ' data-action="submit-solution" data-id="' + escAttr(problem.content_id) + '">' +
        (isSubmitting ? 'Validating… (can take ~30s)' : icon('check') + 'Submit solution') +
        '</button>' +
        '</div>';
    }

    return [
      '<div class="problem-card">',
      '  <div class="chip-row">' + chips.join('') + '</div>',
      '  <h2 class="cp-title">' + escHtml(problem.title || 'Coding Problem') + '</h2>',
      promptHtml,
      expected,
      renderHintsBlock(problem),
      inlineActions,
      renderSubmissionResult(problem),
      '</div>',
    ].join('');
  }

  function renderActionBar(problem) {
    var isSubmitting = !!submittingContent[problem.content_id];
    var secondary = [];
    if (problem.starter_code) {
      secondary.push(
        '<button class="btn btn-quiet" data-action="open-problem" data-id="' +
          escAttr(problem.content_id) + '">' + icon('play') + 'Starter code</button>'
      );
    }
    secondary.push('<button class="btn btn-ai" data-action="request-hint">' + icon('bulb') + 'I\'m stuck</button>');
    return [
      '<div class="action-bar">',
      '  <button class="btn btn-primary"' + (isSubmitting ? ' disabled' : '') +
        ' data-action="submit-solution" data-id="' + escAttr(problem.content_id) + '">' +
        (isSubmitting ? 'Validating your solution… (~30s)' : icon('check') + 'Submit Solution') +
        '</button>',
      '  <div class="action-secondary">' + secondary.join('') + '</div>',
      '</div>',
    ].join('');
  }

  function renderSubmissionResult(problem) {
    var entry = submissionResults[problem.content_id];
    if (!entry) {
      return '';
    }
    if (!entry.success) {
      return '<div class="error-banner anim-slide" id="sub-' + escAttr(problem.content_id) + '">' +
        escHtml(entry.error || 'Submission failed.') + '</div>';
    }
    var v = (entry.result && entry.result.validation) || {};
    var c = (entry.result && entry.result.correction) || {};
    var correctness = v.correctness || c.inferred_correctness || 'incorrect';
    var labels = {
      correct: icon('check') + 'Correct',
      partially_correct: icon('halfCircle') + 'Partially correct',
      incorrect: icon('x') + 'Not quite yet',
      runtime_error: icon('x') + 'Runtime error',
    };
    var classes = {
      correct: 'sub-correct',
      partially_correct: 'sub-partial',
      incorrect: 'sub-incorrect',
      runtime_error: 'sub-incorrect',
    };
    var feedback = c.feedback_summary || v.feedback_summary || '';
    var tests = (v.test_results || [])
      .map(function (t) {
        return '<li class="test-row ' + (t.passed ? 'test-pass' : 'test-fail') + '">' +
          (t.passed ? icon('check') : icon('x')) + '<span>' + escHtml(t.name || 'test') +
          (t.message ? ' — ' + escHtml(t.message) : '') + '</span></li>';
      })
      .join('');
    var chips = (c.suggested_focus || [])
      .slice(0, 6)
      .map(function (f) {
        return '<span class="chip chip-neutral">' + escHtml(f) + '</span>';
      })
      .join('');
    var completeHtml = '';
    if (correctness === 'correct') {
      if (activeTask && activeTask.status === 'completed') {
        completeHtml = '<div class="complete-note">' + icon('check') + 'Task marked complete</div>';
      } else {
        // Completing marks the WHOLE skillpath done (web semantics: all
        // lessons), so say so when there are sibling lessons.
        var others = ((activeTask && activeTask.learning_contents) || []).filter(function (lc) {
          return lc.content_id !== problem.content_id;
        }).length;
        completeHtml =
          (completeError ? '<div class="error-banner">' + escHtml(completeError) + '</div>' : '') +
          (others > 0
            ? '<div class="complete-cap">Marks the whole task done — its ' + others +
              ' other lesson' + (others === 1 ? '' : 's') + ' will show as complete on your roadmap.</div>'
            : '') +
          '<button class="btn btn-success"' + (completingTask ? ' disabled' : '') +
          ' data-action="complete-task">' + (completingTask ? 'Saving…' : 'Mark task complete') + '</button>';
      }
    }
    return [
      '<div class="submission-card anim-slide ' + (classes[correctness] || 'sub-incorrect') +
        '" id="sub-' + escAttr(problem.content_id) + '">',
      '  <div class="sub-head">' + (labels[correctness] || escHtml(correctness)) + '</div>',
      '  <div class="sub-body">',
      feedback ? '    <div class="sub-feedback">' + escHtml(feedback) + '</div>' : '',
      tests ? '    <ul class="test-list">' + tests + '</ul>' : '',
      chips
        ? '    <div class="focus-row"><div class="section-label">Focus next</div><div class="focus-chips">' + chips + '</div></div>'
        : '',
      completeHtml,
      '  </div>',
      '</div>',
    ].join('');
  }

  function renderHintsBlock(problem) {
    if (!Array.isArray(problem.hints) || problem.hints.length === 0) {
      return '';
    }
    var total = problem.hints.length;
    var revealed = Math.min(hintsRevealed[problem.content_id] || 0, total);
    var listHtml = '';
    if (revealed > 0) {
      var items = problem.hints.slice(0, revealed).map(function (h, i) {
        return '<li' + (i === revealed - 1 ? ' class="anim-slide"' : '') +
          '><span class="hint-num">' + (i + 1) + '</span><span>' + escHtml(h) + '</span></li>';
      }).join('');
      listHtml = '<ol class="hints-list">' + items + '</ol>';
    }
    var ctrl;
    if (revealed === 0) {
      ctrl = 'Reveal one at a time' + icon('chevDown');
    } else if (revealed < total) {
      ctrl = 'Reveal next (' + revealed + '/' + total + ')' + icon('chevDown');
    } else {
      ctrl = 'Hide' + icon('chevUp');
    }
    return [
      '<div class="hints-acc">',
      '  <button class="hints-head" data-action="toggle-hints" data-id="' + escAttr(problem.content_id) + '">',
      '    <span class="hints-head-label">',
      '      <span class="hints-icon">' + icon('bulb') + '</span>',
      '      ' + total + ' hint' + (total === 1 ? '' : 's') + ' available',
      '    </span>',
      '    <span class="hints-ctrl">' + ctrl + '</span>',
      '  </button>',
      listHtml,
      '</div>',
    ].join('');
  }

  function contentTypeLabel(type) {
    if (type === 'article') return 'Article';
    if (type === 'coding_problem') return 'Coding Problem';
    if (type === 'multiple_choice') return 'Quiz';
    return type || 'Content';
  }

  // ── Reviews Tab ────────────────────────────────────────────────────────
  function renderReviewsTab() {
    var panel = document.getElementById('panel-reviews');

    // Drill view: a concept is active
    if (activeConcept) {
      renderDrill(panel);
      return;
    }

    // Loading — waiting for fetch response
    if (!reviewsFetched) {
      panel.innerHTML = '<div class="loading-state"><div class="spinner"></div><span>Loading reviews...</span></div>';
      return;
    }

    // Error
    if (reviewsError) {
      panel.innerHTML = [
        '<div class="empty-state">',
        '  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01" stroke-linecap="round"/></svg>',
        '  <div class="empty-title">Could not load reviews</div>',
        '  <div class="empty-sub">' + escHtml(reviewsError) + '</div>',
        '  <button class="btn btn-primary" data-action="retry-reviews">Retry</button>',
        '</div>',
      ].join('');
      return;
    }

    // Empty
    if (reviews.length === 0) {
      panel.innerHTML = [
        '<div class="empty-state">',
        '  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 12l2 2 4-4M12 3a9 9 0 100 18A9 9 0 0012 3z" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        '  <div class="empty-title">All caught up!</div>',
        '  <div class="empty-sub">No reviews due right now. Come back later.</div>',
        '</div>',
      ].join('');
      return;
    }

    var items = reviews.map(renderDueCard).join('');
    panel.innerHTML = [
      '<div class="reviews-head">',
      '  <div class="section-label" style="margin:0">Due for review</div>',
      '  <span class="chip chip-review">' + reviews.length + ' due</span>',
      '</div>',
      items,
    ].join('');
  }

  function renderDueCard(r) {
    var info = reviewDisplayInfo(r);
    var sourceChip = r.source_type === 'struggle_signal'
      ? '<span class="chip chip-review">' + escHtml(info.sourceLabel) + '</span>'
      : '<span class="chip chip-active">' + escHtml(info.sourceLabel) + '</span>';
    var memory;
    if (r.retrievability != null && r.reps > 0) {
      var pct = Math.round(Math.max(0, Math.min(1, r.retrievability)) * 100);
      memory =
        '<div class="memory-row">' +
        '<div class="strength"><div class="strength-fill ' + strengthClass(r.retrievability) +
        '" style="width:' + pct + '%"></div></div>' +
        '<div class="memory-cap">Memory ' + pct + '% · ' + r.reps + ' review' + (r.reps === 1 ? '' : 's') + '</div>' +
        '</div>';
    } else {
      memory = '<div class="memory-cap">First review</div>';
    }
    return [
      '<div class="due-card">',
      '  <div class="chip-row">',
      sourceChip,
      info.language ? '    <span class="lang-tag">' + escHtml(info.language) + '</span>' : '',
      '    <span class="meta-line">' + formatDue(r.due) + '</span>',
      '  </div>',
      '  <div class="due-name">' + escHtml(info.label) + '</div>',
      info.subtitle ? '  <div class="due-sub">' + escHtml(info.subtitle) + '</div>' : '',
      '  <div class="reason-pill">' + icon('sparkle') + escHtml(reviewReason(r)) + '</div>',
      memory,
      '  <button class="btn btn-review" data-action="start-practice" data-id="' + escAttr(r.concept_id) + '">' + icon('play') + 'Start review</button>',
      '</div>',
    ].join('');
  }

  function renderDrill(panel) {
    var info = reviewDisplayInfo(activeConcept);
    var sourceChip = activeConcept.source_type === 'struggle_signal'
      ? '<span class="chip chip-review">' + escHtml(info.sourceLabel) + '</span>'
      : '<span class="chip chip-active">' + escHtml(info.sourceLabel) + '</span>';
    var memoryMeta = '';
    if (activeConcept.retrievability != null && activeConcept.reps > 0) {
      var pct = Math.round(Math.max(0, Math.min(1, activeConcept.retrievability)) * 100);
      memoryMeta =
        '<div class="meta-line drill-meta">' +
        '<span>' + activeConcept.reps + ' prior review' + (activeConcept.reps === 1 ? '' : 's') + '</span>' +
        '<div class="strength"><div class="strength-fill ' + strengthClass(activeConcept.retrievability) +
        '" style="width:' + pct + '%"></div></div>' +
        '<span>' + pct + '%</span>' +
        '</div>';
    }
    var context = [
      '<div class="drill-context">',
      '  <div class="chip-row">',
      sourceChip,
      '    <span class="reason-pill" style="margin:0">' + icon('sparkle') + escHtml(reviewReason(activeConcept)) + '</span>',
      '  </div>',
      '  <div class="drill-name">' + escHtml(info.label) + '</div>',
      memoryMeta,
      '</div>',
    ].join('');

    var body;
    if (practiceLoading) {
      body = '<div class="loading-state"><div class="spinner"></div><span>Generating a fresh drill…</span></div>';
    } else if (practiceError) {
      body = [
        '<div class="empty-state">',
        '  <div class="empty-title">Couldn\'t generate the drill</div>',
        '  <div class="empty-sub">' + escHtml(practiceError) + '</div>',
        '  <button class="btn btn-primary" data-action="retry-drill">Retry</button>',
        '</div>',
      ].join('');
    } else if (gradeSuccess && chosenGrade) {
      var iv = activeConcept.interval_previews;
      body = [
        '<div class="graded-pop anim-pop">',
        '  <div class="graded-icon tone-' + chosenGrade.tone + '">' + icon('check') + '</div>',
        '  <div class="graded-title">Marked “' + chosenGrade.label + '”</div>',
        '  <div class="graded-sub">' +
          (iv && iv[chosenGrade.field] != null
            ? 'Scheduled again in <b class="tone-' + chosenGrade.tone + '">' + formatInterval(iv[chosenGrade.field]) + '</b>'
            : 'Spaced-repetition schedule updated') +
          '</div>',
        '</div>',
      ].join('');
    } else if (practiceTask) {
      var parts = [
        '<div class="drill-body">',
        '  <div class="section-label">Prompt</div>',
        '  <div class="md">' + renderMarkdown(practiceTask.content) + '</div>',
      ];
      if (!solutionRevealed) {
        parts.push(
          '<button class="btn btn-primary" data-action="reveal-solution">Reveal solution</button>',
          '<div class="reveal-cap">Answer it in your head, then check.</div>'
        );
      } else {
        parts.push(
          '<div class="solution-block anim-slide">',
          '  <div class="solution-head">' + icon('check') + 'Solution</div>',
          '  <div class="solution-body"><div class="md">' + renderMarkdown(practiceTask.solution) + '</div></div>',
          '</div>'
        );
        var grading = gradingConceptId === activeConcept.concept_id;
        var iv2 = activeConcept.interval_previews;
        var cards = GRADES.map(function (def) {
          var interval = iv2 && iv2[def.field] != null
            ? '<div class="g-interval">next in <b>' + formatInterval(iv2[def.field]) + '</b></div>'
            : '';
          return (
            '<button class="grade-card ' + def.cls + '"' + (grading ? ' disabled' : '') +
            ' data-action="grade" data-grade="' + def.grade + '">' +
            '<div class="g-label">' + def.label + '</div>' +
            '<div class="g-sub">' + def.sub + '</div>' +
            interval +
            '</button>'
          );
        }).join('');
        parts.push(
          gradeError ? '<div class="error-banner">' + escHtml(gradeError) + '</div>' : '',
          '<div class="grade-section">',
          '  <h3 class="grade-q">' + (grading ? 'Saving…' : 'How well did you recall it?') + '</h3>',
          '  <div class="grade-grid">' + cards + '</div>',
          '  <div class="grade-foot">Your grade updates the spaced-repetition schedule</div>',
          '</div>'
        );
      }
      parts.push('</div>');
      body = parts.join('');
    } else {
      body = '';
    }

    panel.innerHTML = [
      '<button class="drill-back" data-action="back-to-list">' + icon('chevLeft') + 'Queue</button>',
      '<div class="drill-card">',
      context,
      body,
      '</div>',
    ].join('');
  }

  function strengthClass(value) {
    return value < 0.45 ? 'strength-low' : value < 0.7 ? 'strength-mid' : 'strength-high';
  }

  function reviewDisplayInfo(r) {
    var meta = r.concept_metadata || {};
    if (r.source_type === 'skill_path') {
      return {
        label: meta.title || 'Skill Path Review',
        sourceLabel: contentTypeLabel(meta.content_type) || 'Skill Path',
        subtitle: meta.description || null,
      };
    }
    return {
      label: meta.concept_name || meta.concept || 'Programming Concept',
      sourceLabel: 'Weakness',
      subtitle: meta.misconception || null,
      language: meta.language && meta.language !== 'unknown' ? meta.language : null,
    };
  }

  // Reason-chip copy mirrors the frontend (DESIGN.md §3: explicit rationale).
  function reviewReason(r) {
    return r.source_type === 'struggle_signal'
      ? 'Based on a recent bug pattern'
      : 'Based on review decay';
  }

  // Compact interval label from fractional days (port of the frontend's
  // formatIntervalDays): 0.25 → "6h", 5 → "5d", 45 → "2mo".
  function formatInterval(days) {
    var minutes = days * 24 * 60;
    if (minutes < 1) return '<1m';
    if (minutes < 90) return Math.round(minutes) + 'm';
    if (days < 1) return Math.round(days * 24) + 'h';
    if (days < 30) return Math.max(1, Math.round(days)) + 'd';
    if (days < 360) return Math.round(days / 30) + 'mo';
    return Math.round(days / 365) + 'y';
  }

  function startPractice(conceptId) {
    activeConcept = reviews.find(function (r) {
      return r.concept_id === conceptId;
    });
    if (!activeConcept) {
      return;
    }
    practiceTask = null;
    practiceLoading = true;
    practiceError = null;
    gradeError = null;
    chosenGrade = null;
    solutionRevealed = false;
    renderReviewsTab();
    vscode.postMessage({ command: 'generateTask', conceptId: conceptId });
  }

  function retryDrill() {
    if (!activeConcept) {
      return;
    }
    practiceTask = null;
    practiceLoading = true;
    practiceError = null;
    renderReviewsTab();
    vscode.postMessage({ command: 'generateTask', conceptId: activeConcept.concept_id });
  }

  function backToList() {
    activeConcept = null;
    practiceTask = null;
    practiceLoading = false;
    practiceError = null;
    gradeError = null;
    chosenGrade = null;
    solutionRevealed = false;
    renderReviewsTab();
  }

  function grade(g) {
    if (!activeConcept || gradingConceptId !== null) {
      return;
    }
    gradingConceptId = activeConcept.concept_id;
    chosenGrade = GRADES.find(function (def) {
      return def.grade === g;
    }) || null;
    gradeError = null;
    renderReviewsTab();
    vscode.postMessage({ command: 'gradeReview', conceptId: activeConcept.concept_id, grade: g });
  }

  function retryReviews() {
    reviewsFetched = false;
    reviewsError = null;
    reviews = [];
    renderReviewsTab(); // shows spinner
    vscode.postMessage({ command: 'fetchDueReviews' });
  }

  function retryRoadmap() {
    roadmapFetched = false;
    roadmapError = null;
    renderRoadmapTab(); // shows spinner
    vscode.postMessage({ command: 'fetchRoadmap' });
  }

  // ── Roadmap Tab ────────────────────────────────────────────────────────
  function renderRoadmapTab() {
    var panel = document.getElementById('panel-roadmap');

    if (roadmapError) {
      panel.innerHTML = [
        '<div class="empty-state">',
        '  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 20H5a2 2 0 01-2-2V6a2 2 0 012-2h4M15 4h4a2 2 0 012 2v12a2 2 0 01-2 2h-4M12 8v8M9 12h6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        '  <div class="empty-title">Could not load roadmap</div>',
        '  <div class="empty-sub">' + escHtml(roadmapError) + '</div>',
        '  <button class="btn btn-primary" data-action="retry-roadmap">Retry</button>',
        '</div>',
      ].join('');
      return;
    }

    if (!roadmapFetched) {
      panel.innerHTML = '<div class="loading-state"><div class="spinner"></div><span>Loading roadmap...</span></div>';
      return;
    }
    if (!roadmap) {
      panel.innerHTML = [
        '<div class="empty-state">',
        '  <div class="empty-title">No roadmap data</div>',
        '  <div class="empty-sub">The roadmap response was empty.</div>',
        '</div>',
      ].join('');
      return;
    }

    var milestones = roadmap.milestones || [];
    var skillpaths = flattenRoadmapSkillpaths(roadmap);
    var roadmapInfo = roadmap.roadmap || roadmap;

    if (milestones.length === 0) {
      panel.innerHTML = [
        '<div class="empty-state">',
        '  <div class="empty-title">No milestones yet</div>',
        '  <div class="empty-sub">This roadmap has no milestones generated.</div>',
        '</div>',
      ].join('');
      return;
    }

    var activeTaskId = activeTask ? activeTask.skillpath_id : null;
    var html = [
      '<div class="roadmap-head">',
      '  <span class="chip chip-neutral">Roadmap</span>',
      '  <div class="roadmap-title">' + escHtml(roadmapInfo.title || 'My Roadmap') + '</div>',
      '</div>',
    ];

    milestones.forEach(function (m, mIdx) {
      var isOpen = expandedMilestones.has(m.milestone_id);
      var mSkillpaths = skillpaths.filter(function (s) {
        return s.milestone_id === m.milestone_id;
      });
      var doneCount = mSkillpaths.filter(function (s) {
        return s.status === 'completed';
      }).length;
      var spHtml = mSkillpaths
        .map(function (sp) {
          var isActive = sp.skillpath_id === activeTaskId;
          var isCompleted = sp.status === 'completed';
          var hours = sp.estimated_hours ? '<span class="sp-hours">' + sp.estimated_hours + 'h</span>' : '';
          // Any generated content makes the task selectable — the Task tab
          // handles article/quiz-only tasks itself (and offers regeneration
          // there), so only truly empty skillpaths keep the Generate button.
          if (hasLearningContent(sp)) {
            return [
              '<div class="sp-row' + (isActive ? ' sp-active' : '') + (isCompleted ? ' sp-done' : '') +
                '" role="button" tabindex="0" data-action="select-task" data-id="' + escAttr(sp.skillpath_id) + '">',
              '  <span class="sp-dot"></span>',
              '  <span class="sp-title">' + escHtml(sp.title) + '</span>',
              isCompleted ? '<span class="chip chip-success">' + icon('check') + '</span>' : '',
              hours,
              '</div>',
            ].join('');
          }
          var isGenerating = generatingSkillpaths.has(sp.skillpath_id);
          var spErr = roadmapGenerateErrors[sp.skillpath_id];
          return [
            '<div class="sp-row sp-empty" title="No learning content yet — generate to start">',
            '  <span class="sp-dot"></span>',
            '  <span class="sp-title">' + escHtml(sp.title) + '</span>',
            hours,
            '  <button class="btn btn-quiet btn-sm sp-gen-btn"' + (isGenerating ? ' disabled' : '') +
              ' data-action="generate-for-skillpath" data-id="' + escAttr(sp.skillpath_id) + '">' +
              (isGenerating ? 'Generating…' : 'Generate') + '</button>',
            spErr ? '<div class="sp-error">' + escHtml(spErr) + '</div>' : '',
            '</div>',
          ].join('');
        })
        .join('');

      html.push(
        '<div class="milestone-card">',
        '  <div class="milestone-header" role="button" tabindex="0" aria-expanded="' + (isOpen ? 'true' : 'false') +
          '" data-action="toggle-milestone" data-id="' + escAttr(m.milestone_id) + '">',
        '    <span class="m-chevron' + (isOpen ? ' open' : '') + '">' + icon('chevRight') + '</span>',
        '    <span class="m-title">' + escHtml(m.title) + '</span>',
        '    <span class="m-progress' + (mSkillpaths.length > 0 && doneCount === mSkillpaths.length ? ' m-done' : '') + '">' +
          doneCount + '/' + mSkillpaths.length + '</span>',
        // Number by list position: the backend returns milestones sorted, and
        // order_index is 1-based (enumerate(start=1)), so +1 displayed "#2" first.
        '    <span class="m-idx">#' + (mIdx + 1) + '</span>',
        '  </div>',
        '  <div class="skillpath-list' + (isOpen ? ' open' : '') + '">' + spHtml + '</div>',
        '</div>',
      );
    });

    panel.innerHTML = html.join('');
  }

  function toggleMilestone(milestoneId) {
    if (expandedMilestones.has(milestoneId)) {
      expandedMilestones.delete(milestoneId);
    } else {
      expandedMilestones.add(milestoneId);
    }
    renderRoadmapTab();
  }

  function selectTask(skillpathId) {
    var sp = flattenRoadmapSkillpaths(roadmap).find(function (s) {
      return s.skillpath_id === skillpathId;
    });
    if (sp && hasLearningContent(sp)) {
      vscode.postMessage({ command: 'setActiveTask', task: sp });
    }
  }

  function generateForSkillpath(skillpathId) {
    if (!roadmap || !skillpathId) {
      return;
    }
    var sp = flattenRoadmapSkillpaths(roadmap).find(function (s) {
      return s.skillpath_id === skillpathId;
    });
    if (!sp) {
      return;
    }
    var roadmapId = sp.roadmap_id || (roadmap.roadmap || roadmap).roadmap_id || activeRoadmapId;
    if (!roadmapId) {
      roadmapGenerateErrors[skillpathId] = 'No roadmap loaded.';
      renderRoadmapTab();
      return;
    }
    var hasContent = Array.isArray(sp.learning_contents) && sp.learning_contents.length > 0;
    generatingSkillpaths.add(skillpathId);
    delete roadmapGenerateErrors[skillpathId];
    renderRoadmapTab();
    vscode.postMessage({
      command: 'generateSkillpathContent',
      roadmapId: roadmapId,
      skillpathId: skillpathId,
      force: hasContent,
    });
  }

  function hasLearningContent(sp) {
    return !!sp && Array.isArray(sp.learning_contents) && sp.learning_contents.length > 0;
  }

  // ── Task-tab interactions ──────────────────────────────────────────────
  function toggleHints(contentId) {
    if (!activeTask) {
      return;
    }
    var contents = Array.isArray(activeTask.learning_contents) ? activeTask.learning_contents : [];
    var problem = contents.find(function (c) {
      return c.content_id === contentId && c.content_type === 'coding_problem';
    });
    if (!problem || !Array.isArray(problem.hints) || problem.hints.length === 0) {
      return;
    }
    var current = hintsRevealed[contentId] || 0;
    // One more per click; once everything is out, the same control hides.
    hintsRevealed[contentId] = current >= problem.hints.length ? 0 : current + 1;
    renderTaskTab();
  }

  function togglePrompt(contentId) {
    promptExpanded[contentId] = !promptExpanded[contentId];
    renderTaskTab();
  }

  function openCodingProblem(contentId) {
    if (!activeTask) return;
    var contents = Array.isArray(activeTask.learning_contents) ? activeTask.learning_contents : [];
    var problem = contents.find(function (c) {
      return c.content_id === contentId && c.content_type === 'coding_problem';
    });
    if (!problem || !problem.starter_code) return;
    vscode.postMessage({
      command: 'openCodingProblem',
      contentId: contentId,
      starterCode: problem.starter_code,
      title: problem.title || activeTask.title,
    });
  }

  function requestHint() {
    if (!activeTask) return;
    vscode.postMessage({ command: 'requestHint' });
  }

  function submitSolution(contentId) {
    if (!activeTask || submittingContent[contentId]) return;
    submittingContent[contentId] = true;
    renderTaskTab();
    vscode.postMessage({ command: 'submitSolution', contentId: contentId });
  }

  function completeTask() {
    if (!activeTask || completingTask) return;
    completingTask = true;
    completeError = null;
    renderTaskTab();
    vscode.postMessage({ command: 'completeTask' });
  }

  function generateContent() {
    if (!activeTask || !activeTask.skillpath_id) return;
    var roadmapId = activeTask.roadmap_id || activeRoadmapId;
    if (!roadmapId) {
      contentError = 'No roadmap is loaded. Open this task from the dashboard first.';
      renderTaskTab();
      return;
    }
    contentGenerating = true;
    contentError = null;
    renderTaskTab();
    vscode.postMessage({
      command: 'generateSkillpathContent',
      roadmapId: roadmapId,
      skillpathId: activeTask.skillpath_id,
      force: !activeTask.need_generation,
    });
  }

  // ── Hint Notification ──────────────────────────────────────────────────
  // No auto-dismiss: re-requesting a hint escalates the hint level, so a
  // missed toast is unrecoverable. It stays until the user closes it.
  function showHint(text, conceptName) {
    document.getElementById('hint-body').innerHTML = escHtml(text).replace(/\n/g, '<br>');
    var footer = document.getElementById('hint-footer');
    if (conceptName) {
      footer.textContent = '+ Added "' + conceptName + '" to your review queue';
      footer.style.display = 'block';
    } else {
      footer.style.display = 'none';
    }
    var notif = document.getElementById('hint-notif');
    notif.inert = false; // restore to tab order / accessibility tree
    notif.classList.add('show');
  }
  function closeHint() {
    var notif = document.getElementById('hint-notif');
    notif.classList.remove('show');
    notif.inert = true; // offscreen toast must not trap keyboard focus
  }

  // ── Event delegation ───────────────────────────────────────────────────
  // All rendered interactions go through data-action attributes (no inline
  // handlers — the webview CSP allows only the nonce'd script).
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-action]') : null;
    if (!el || el.disabled) {
      return;
    }
    var id = el.getAttribute('data-id');
    switch (el.getAttribute('data-action')) {
      case 'open-problem': openCodingProblem(id); break;
      case 'submit-solution': submitSolution(id); break;
      case 'request-hint': requestHint(); break;
      case 'toggle-hints': toggleHints(id); break;
      case 'toggle-prompt': togglePrompt(id); break;
      case 'complete-task': completeTask(); break;
      case 'generate-content': generateContent(); break;
      case 'start-practice': startPractice(id); break;
      case 'retry-drill': retryDrill(); break;
      case 'back-to-list': backToList(); break;
      case 'reveal-solution':
        solutionRevealed = true;
        renderReviewsTab();
        break;
      case 'grade': grade(Number(el.getAttribute('data-grade'))); break;
      case 'retry-reviews': retryReviews(); break;
      case 'retry-roadmap': retryRoadmap(); break;
      case 'toggle-milestone': toggleMilestone(id); break;
      case 'select-task': selectTask(id); break;
      case 'generate-for-skillpath': generateForSkillpath(id); break;
      case 'close-hint': closeHint(); break;
    }
  });

  // Keyboard operability for clickable div rows (milestones, skillpaths):
  // Enter/Space activates anything marked role="button".
  document.addEventListener('keydown', function (e) {
    if ((e.key === 'Enter' || e.key === ' ') && e.target && e.target.matches &&
        e.target.matches('[role="button"]')) {
      e.preventDefault();
      e.target.click();
    }
  });

  // ── Utilities ──────────────────────────────────────────────────────────
  function escHtml(str) {
    if (!str) {
      return '';
    }
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escAttr(str) {
    if (str === null || str === undefined) {
      return '';
    }
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/'/g, '&#39;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function flattenRoadmapSkillpaths(roadmapData) {
    if (!roadmapData) {
      return [];
    }
    if (Array.isArray(roadmapData.skillpaths)) {
      return roadmapData.skillpaths;
    }
    return (roadmapData.milestones || []).flatMap(function (milestone) {
      return (milestone.skillpaths || []).map(function (skillpath) {
        return Object.assign({}, skillpath, {
          roadmap_id: skillpath.roadmap_id || roadmapData.roadmap_id,
          milestone_id: skillpath.milestone_id || milestone.milestone_id,
        });
      });
    });
  }

  function formatDue(isoStr) {
    try {
      var due = new Date(isoStr);
      var now = new Date();
      var diffMs = now - due;
      var diffMin = Math.floor(diffMs / 60000);
      if (diffMin < 1) {
        return 'Due now';
      }
      if (diffMin < 60) {
        return diffMin + 'm overdue';
      }
      var diffH = Math.floor(diffMin / 60);
      if (diffH < 24) {
        return diffH + 'h overdue';
      }
      return Math.floor(diffH / 24) + 'd overdue';
    } catch (e) {
      return '';
    }
  }

  function renderMarkdown(text) {
    if (!text) {
      return '';
    }
    // Escape HTML
    var safe = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    // Stash fenced code blocks so block-level rules don't mangle them
    var codeBlocks = [];
    safe = safe.replace(/```[\w]*\n?([\s\S]*?)```/g, function (_, code) {
      var i = codeBlocks.push('<pre><code>' + code.replace(/^\n+|\n+$/g, '') + '</code></pre>') - 1;
      return '\n\nMDCB' + i + '\n\n';
    });

    // Inline markdown (run before block split so it works across all blocks)
    safe = safe.replace(/`([^`\n]+)`/g, '<code class="inline-code">$1</code>');
    safe = safe.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');

    // Split into blocks on blank lines
    var blocks = safe.split(/\n\s*\n+/);
    var html = blocks.map(function (block) {
      block = block.replace(/^\n+|\n+$/g, '');
      if (!block) {
        return '';
      }

      // Header
      var h = /^(#{1,3})\s+(.+)$/.exec(block);
      if (h && block.indexOf('\n') === -1) {
        var lvl = h[1].length;
        return '<h' + lvl + '>' + h[2] + '</h' + lvl + '>';
      }

      // Single code-block placeholder is its own block
      if (/^MDCB\d+$/.test(block)) {
        return block;
      }

      var lines = block.split(/\n/).map(function (l) {
        return l.replace(/^\s+|\s+$/g, '');
      }).filter(function (l) {
        return l;
      });
      if (lines.length === 0) {
        return '';
      }

      // Group consecutive lines into runs of the same type so a block like
      // "Leader line\n* Item 1\n* Item 2" renders as <p> + <ul>, not as one paragraph.
      var groups = [];
      lines.forEach(function (l) {
        var type;
        if (/^\d+\.\s+/.test(l)) {
          type = 'ol';
        } else if (/^[-*+]\s+/.test(l)) {
          type = 'ul';
        } else {
          type = 'p';
        }
        var last = groups[groups.length - 1];
        if (last && last.type === type) {
          last.items.push(l);
        } else {
          groups.push({ type: type, items: [l] });
        }
      });

      return groups.map(function (g) {
        if (g.type === 'ol') {
          var startMatch = /^(\d+)\./.exec(g.items[0]);
          var startNum = startMatch ? parseInt(startMatch[1], 10) : 1;
          var startAttr = startNum > 1 ? ' start="' + startNum + '"' : '';
          return '<ol' + startAttr + '>' +
            g.items.map(function (l) {
              return '<li>' + l.replace(/^\d+\.\s+/, '') + '</li>';
            }).join('') +
            '</ol>';
        }
        if (g.type === 'ul') {
          return '<ul>' +
            g.items.map(function (l) {
              return '<li>' + l.replace(/^[-*+]\s+/, '') + '</li>';
            }).join('') +
            '</ul>';
        }
        return '<p>' + g.items.join('<br>') + '</p>';
      }).join('');
    }).join('\n');

    // Restore code blocks (also strip <p> wrapper if block parser wrapped a lone placeholder)
    html = html.replace(/<p>(MDCB\d+)<\/p>/g, '$1');
    html = html.replace(/MDCB(\d+)/g, function (_, i) {
      return codeBlocks[parseInt(i, 10)];
    });

    return html;
  }

  // Initial render
  renderTaskTab();

  // Ready handshake: the provider replays the active task only after this,
  // so state posted while the iframe was still loading is never dropped.
  vscode.postMessage({ command: 'webviewReady' });
})();
