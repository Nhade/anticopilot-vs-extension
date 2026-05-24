(function () {
  const vscode = acquireVsCodeApi();

  // ── State ──────────────────────────────────────────────────────────────
  let currentTab = 'task';
  let activeTask = null;
  let activeRoadmapId = null;

  // Reviews state
  let reviews = [];
  let reviewsRequested = false; // fetch has been sent
  let reviewsFetched = false; // response received
  let reviewsError = null;
  let activeConcept = null;
  let practiceTask = null;
  let practiceLoading = false;
  let practiceError = null;
  let showSolution = false;
  let gradingConceptId = null;
  let gradeSuccess = false;

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
  // UI state for the task tab: incremental hint reveal per coding problem
  let hintsRevealed = {}; // contentId -> count of hints revealed so far

  // ── Tab switching ──────────────────────────────────────────────────────
  document.querySelectorAll('.tab-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      switchTab(btn.getAttribute('data-tab'));
    });
  });

  function switchTab(tab) {
    currentTab = tab;
    document.querySelectorAll('.tab-btn').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === tab);
    });
    document.querySelectorAll('.panel').forEach(function (p) {
      p.classList.toggle('active', p.id === 'panel-' + tab);
    });
    if (tab === 'reviews' && !reviewsRequested) {
      reviewsRequested = true;
      renderReviewsTab(); // shows spinner
      vscode.postMessage({ command: 'fetchDueReviews' });
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
      case 'updateTask':
        activeTask = msg.task;
        contentGenerating = false;
        contentError = null;
        hintsRevealed = {};
        if (msg.roadmapId && msg.roadmapId !== activeRoadmapId) {
          activeRoadmapId = msg.roadmapId;
          roadmap = null;
          roadmapRequested = false;
          roadmapFetched = false;
        }
        renderTaskTab();
        break;
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
      case 'showHint':
        showHint(msg.hint, msg.conceptName);
        break;
      case 'dueReviews':
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
          showSolution = false;
        }
        renderReviewsTab();
        break;
      case 'gradeResult':
        gradingConceptId = null;
        if (msg.success) {
          gradeSuccess = true;
          // Remove graded concept from list and reset practice view
          reviews = reviews.filter(function (r) {
            return r.concept_id !== msg.conceptId;
          });
          setTimeout(function () {
            gradeSuccess = false;
            activeConcept = null;
            practiceTask = null;
            showSolution = false;
            renderReviewsTab();
          }, 1200);
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
        '  <div class="empty-title">No Active Task</div>',
        '  <div class="empty-sub">Select a task from the dashboard to focus on your progress.</div>',
        '</div>',
      ].join('');
      return;
    }

    var allContents = Array.isArray(activeTask.learning_contents) ? activeTask.learning_contents : [];
    var codingProblems = allContents.filter(function (c) {
      return c.content_type === 'coding_problem';
    });
    var practiceModeHtml = activeTask.practice_mode
      ? '<div class="badge badge-purple">Practice: ' +
        escHtml(String(activeTask.practice_mode).replace(/_/g, ' ')) +
        '</div>'
      : '';

    var contentHtml;
    if (codingProblems.length > 0) {
      contentHtml = codingProblems.map(renderCodingProblemFullPage).join('');
    } else if (allContents.length > 0) {
      contentHtml = [
        '<div class="content-empty">',
        '  <div class="content-empty-title">No coding problem yet</div>',
        '  <div class="content-empty-sub">This task has ' + allContents.length + ' learning ' +
          (allContents.length === 1 ? 'item' : 'items') +
          ' (articles or quizzes). Open the dashboard to view them, or regenerate to add a coding problem.</div>',
        contentError ? '<div class="error-banner">' + escHtml(contentError) + '</div>' : '',
        '  <button class="practice-btn"' + (contentGenerating ? ' disabled' : '') + ' onclick="generateContent()">' +
          escHtml(contentGenerating ? 'Generating…' : 'Regenerate Content') + '</button>',
        '</div>',
      ].join('');
    } else {
      contentHtml = renderGenerateContentPanel();
    }

    var html = [
      '<div class="task-tab-root">',
      '  <div class="task-tab-header">',
      '    <div class="badge-row">',
      '      <div class="badge badge-teal">Active Task</div>',
             practiceModeHtml,
      '    </div>',
      '    <h1 class="title">' + escHtml(activeTask.title) + '</h1>',
      '  </div>',
      contentHtml,
      '</div>',
    ];

    panel.innerHTML = html.join('');
  }

  function renderCodingProblemFullPage(problem) {
    var difficultyClass = problem.difficulty === 'easy' ? 'badge-teal' : 'badge-orange';
    var difficulty = problem.difficulty
      ? '<span class="badge ' + difficultyClass + '">' + escHtml(problem.difficulty) + '</span>'
      : '';
    var titleRow =
      '<div class="cp-header">' +
      '  <div class="cp-meta-row">' +
      '    <span class="cp-label">Problem</span>' +
           difficulty +
      '  </div>' +
      '  <h2 class="cp-title">' + escHtml(problem.title || 'Coding Problem') + '</h2>' +
      '</div>';
    var promptBlock = problem.prompt
      ? '<div class="task-content cp-prompt">' + renderMarkdown(problem.prompt) + '</div>'
      : '';
    var openBtn = problem.starter_code
      ? '<button class="practice-btn cp-open-btn" onclick="openCodingProblem(\'' + escAttr(problem.content_id) + '\')">▶ Open Starter Code in Editor</button>'
      : '';
    var expected = problem.expected_output
      ? '<div class="content-block"><div class="section-label">Expected Output</div>' +
        '<div class="task-content cp-prompt">' + renderMarkdown(problem.expected_output) + '</div></div>'
      : '';
    var hintsHtml = renderHintsBlock(problem);
    return '<div class="coding-problem-full">' + titleRow + promptBlock + openBtn + expected + hintsHtml + '</div>';
  }

  function renderHintsBlock(problem) {
    if (!Array.isArray(problem.hints) || problem.hints.length === 0) {
      return '';
    }
    var total = problem.hints.length;
    var revealed = hintsRevealed[problem.content_id] || 0;
    var listHtml = '';
    if (revealed > 0) {
      var items = problem.hints.slice(0, revealed).map(function (h, i) {
        return '<li><span class="hint-num">Hint ' + (i + 1) + '</span> ' + escHtml(h) + '</li>';
      }).join('');
      listHtml = '<ol class="hints-list">' + items + '</ol>';
    }
    var btnLabel;
    var btnDisabled = '';
    if (revealed === 0) {
      btnLabel = '💡 Reveal first hint (' + total + ' total)';
    } else if (revealed < total) {
      btnLabel = '💡 Reveal next hint (' + revealed + ' / ' + total + ' shown)';
    } else {
      btnLabel = 'All ' + total + ' hint' + (total === 1 ? '' : 's') + ' revealed';
      btnDisabled = ' disabled';
    }
    return (
      '<div class="content-block hints-block">' +
      listHtml +
      '<button class="hint-toggle"' + btnDisabled +
      ' onclick="revealNextHint(\'' + escAttr(problem.content_id) + '\')">' +
      escHtml(btnLabel) +
      '</button>' +
      '</div>'
    );
  }

  function renderGenerateContentPanel() {
    var errHtml = contentError
      ? '<div class="error-banner">' + escHtml(contentError) + '</div>'
      : '';
    var btnLabel = contentGenerating ? 'Generating…' : 'Generate Learning Content';
    var btnDisabled = contentGenerating ? ' disabled' : '';
    return [
      '<div class="content-empty">',
      '  <div class="content-empty-title">No learning content yet</div>',
      '  <div class="content-empty-sub">Generate an article, coding problem, or quiz for this skillpath.</div>',
      errHtml,
      '  <button class="practice-btn"' + btnDisabled + ' onclick="generateContent()">' + escHtml(btnLabel) + '</button>',
      '</div>',
    ].join('');
  }

  function contentTypeLabel(type) {
    if (type === 'article') return 'Article';
    if (type === 'coding_problem') return 'Coding Problem';
    if (type === 'multiple_choice') return 'Quiz';
    return type || 'Content';
  }

  window.revealNextHint = function (contentId) {
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
    if (current >= problem.hints.length) {
      return;
    }
    hintsRevealed[contentId] = current + 1;
    renderTaskTab();
  };

  window.openCodingProblem = function (contentId) {
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
  };

  window.generateContent = function () {
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
  };

  // ── Reviews Tab ────────────────────────────────────────────────────────
  function renderReviewsTab() {
    var panel = document.getElementById('panel-reviews');

    // Practice view: a concept is active
    if (activeConcept) {
      if (gradeSuccess) {
        panel.innerHTML = '<div class="grade-success">✓ Graded! See you next time.</div>';
        return;
      }
      renderPracticeView(panel);
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
        '  <button class="practice-btn" style="width:auto;padding:6px 16px" onclick="retryReviews()">Retry</button>',
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

    // Review list
    var items = reviews
      .map(function (r, _idx) {
        var info = reviewDisplayInfo(r);
        var stateLabel = ['New', 'Learning', 'Review', 'Relearning'][r.state] || 'Learning';
        var stateClass = r.state === 2 ? 'badge-orange' : 'badge-teal';
        var dueText = formatDue(r.due);
        return [
          '<div class="review-card">',
          '  <div class="review-card-header">',
          '    <span class="badge badge-muted" style="margin-bottom:4px">' + escHtml(info.sourceLabel) + '</span>',
          '    <div class="review-concept-name">' + escHtml(info.label) + '</div>',
          info.subtitle ? '    <div class="review-subtitle">' + escHtml(info.subtitle) + '</div>' : '',
          '  </div>',
          '  <div class="review-meta">',
          info.language ? '    <span class="badge badge-muted">' + escHtml(info.language) + '</span>' : '',
          '    <span class="badge ' + stateClass + '">' + stateLabel + '</span>',
          '    <span style="font-size:11px;color:var(--muted)">' + dueText + '</span>',
          '  </div>',
          info.misconception ? '  <div class="review-misconception">' + escHtml(info.misconception) + '</div>' : '',
          '  <button class="practice-btn" onclick="startPractice(\'' + escAttr(r.concept_id) + '\')">Practice</button>',
          '</div>',
        ].join('');
      })
      .join('');

    panel.innerHTML = '<div id="review-list-check" class="review-list">' + items + '</div>';
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
      subtitle: null,
      language: meta.language && meta.language !== 'unknown' ? meta.language : null,
      misconception: meta.misconception || null,
    };
  }

  function renderPracticeView(panel) {
    if (practiceLoading) {
      panel.innerHTML = [
        '<div class="practice-header">',
        '  <button class="back-btn" onclick="backToList()">← Back</button>',
        '  <span class="practice-concept-name">' + escHtml(reviewDisplayInfo(activeConcept).label) + '</span>',
        '</div>',
        '<div class="loading-state"><div class="spinner"></div><span>Generating task...</span></div>',
      ].join('');
      return;
    }

    if (practiceError) {
      panel.innerHTML = [
        '<div class="practice-header">',
        '  <button class="back-btn" onclick="backToList()">← Back</button>',
        '</div>',
        '<div class="empty-state">',
        '  <div class="empty-title">Generation failed</div>',
        '  <div class="empty-sub">' + escHtml(practiceError) + '</div>',
        '</div>',
      ].join('');
      return;
    }

    if (!practiceTask) {
      return;
    }

    var gradeDisabled = gradingConceptId === activeConcept.concept_id ? ' disabled' : '';
    var solutionClass = showSolution ? ' visible' : '';
    var toggleLabel = showSolution ? '▲ Hide Solution' : '▼ Show Solution';

    panel.innerHTML = [
      '<div class="practice-header">',
      '  <button class="back-btn" onclick="backToList()">← Back</button>',
      '  <span class="practice-concept-name">' + escHtml(reviewDisplayInfo(activeConcept).label) + '</span>',
      '</div>',
      '<div class="section-label" style="margin-bottom:8px">Task</div>',
      '<div class="task-content">' + renderMarkdown(practiceTask.content) + '</div>',
      '<button class="solution-toggle" onclick="toggleSolution()">' + toggleLabel + '</button>',
      '<div class="solution-content' + solutionClass + '">',
      '  <div class="section-label" style="margin-bottom:8px">Solution</div>',
      '  <div class="task-content">' + renderMarkdown(practiceTask.solution) + '</div>',
      '</div>',
      '<div class="grade-label">How did it go?</div>',
      '<div class="grade-grid">',
      '  <button class="grade-btn grade-again"' +
        gradeDisabled +
        ' onclick="grade(1)">Again<small>Forgot completely</small></button>',
      '  <button class="grade-btn grade-hard"' +
        gradeDisabled +
        ' onclick="grade(2)">Hard<small>Struggled a lot</small></button>',
      '  <button class="grade-btn grade-good"' +
        gradeDisabled +
        ' onclick="grade(3)">Good<small>Got it with effort</small></button>',
      '  <button class="grade-btn grade-easy"' +
        gradeDisabled +
        ' onclick="grade(4)">Easy<small>Perfect recall</small></button>',
      '</div>',
    ].join('');
  }

  function startPractice(conceptId) {
    activeConcept = reviews.find(function (r) {
      return r.concept_id === conceptId;
    });
    practiceTask = null;
    practiceLoading = true;
    practiceError = null;
    showSolution = false;
    renderReviewsTab();
    vscode.postMessage({ command: 'generateTask', conceptId: conceptId });
  }

  function backToList() {
    activeConcept = null;
    practiceTask = null;
    practiceLoading = false;
    showSolution = false;
    renderReviewsTab();
  }

  function toggleSolution() {
    showSolution = !showSolution;
    renderReviewsTab();
  }

  function grade(g) {
    gradingConceptId = activeConcept.concept_id;
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

  // ── Roadmap Tab ────────────────────────────────────────────────────────
  function renderRoadmapTab() {
    var panel = document.getElementById('panel-roadmap');

    if (roadmapError) {
      panel.innerHTML = [
        '<div class="empty-state">',
        '  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 20H5a2 2 0 01-2-2V6a2 2 0 012-2h4M15 4h4a2 2 0 012 2v12a2 2 0 01-2 2h-4M12 8v8M9 12h6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        '  <div class="empty-title">No roadmap loaded</div>',
        '  <div class="empty-sub">' + escHtml(roadmapError) + '</div>',
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
      '<div style="margin-bottom:12px">',
      '  <div class="badge badge-purple" style="margin-bottom:6px">Roadmap</div>',
      '  <div style="font-size:14px;font-weight:700;letter-spacing:-0.01em">' +
        escHtml(roadmapInfo.title || 'My Roadmap') +
        '</div>',
      '</div>',
      '<div class="milestone-list">',
    ];

    milestones.forEach(function (m) {
      var isOpen = expandedMilestones.has(m.milestone_id);
      var mSkillpaths = skillpaths.filter(function (s) {
        return s.milestone_id === m.milestone_id;
      });
      var spHtml = mSkillpaths
        .map(function (sp) {
          var isActive = sp.skillpath_id === activeTaskId;
          var hours = sp.estimated_hours ? sp.estimated_hours + 'h' : '';
          var hasCp = hasCodingProblem(sp);
          var hoursHtml = hours ? '<span class="skillpath-hours">' + hours + '</span>' : '';
          if (hasCp) {
            return [
              '<div class="skillpath-item' + (isActive ? ' active-task' : '') +
                '" onclick="selectTask(\'' + escAttr(sp.skillpath_id) + '\')">',
              '  <span class="skillpath-title">' + escHtml(sp.title) + '</span>',
              hoursHtml,
              '</div>',
            ].join('');
          }
          var isGenerating = generatingSkillpaths.has(sp.skillpath_id);
          var hasContent = Array.isArray(sp.learning_contents) && sp.learning_contents.length > 0;
          var btnLabel = isGenerating ? 'Generating…' : (hasContent ? 'Regenerate' : 'Generate');
          var btnDisabled = isGenerating ? ' disabled' : '';
          var spErr = roadmapGenerateErrors[sp.skillpath_id];
          var errHtml = spErr ? '<div class="skillpath-error">' + escHtml(spErr) + '</div>' : '';
          return [
            '<div class="skillpath-item skillpath-disabled" title="No coding problem yet — generate to unlock">',
            '  <span class="skillpath-title">' + escHtml(sp.title) + '</span>',
            hoursHtml,
            '  <button class="generate-btn"' + btnDisabled +
              ' onclick="generateForSkillpath(event, \'' + escAttr(sp.skillpath_id) + '\')">' +
              escHtml(btnLabel) + '</button>',
            errHtml,
            '</div>',
          ].join('');
        })
        .join('');

      html.push(
        '<div class="milestone-item">',
        '  <div class="milestone-header" onclick="toggleMilestone(\'' + m.milestone_id + '\')">',
        '    <span class="milestone-expand' + (isOpen ? ' open' : '') + '">▶</span>',
        '    <span class="milestone-title">' + escHtml(m.title) + '</span>',
        '    <span class="milestone-idx">' + (m.order_index != null ? '#' + (m.order_index + 1) : '') + '</span>',
        '  </div>',
        '  <div class="skillpath-list' + (isOpen ? ' open' : '') + '">' + spHtml + '</div>',
        '</div>',
      );
    });

    html.push('</div>');
    panel.innerHTML = html.join('');
  }

  window.toggleMilestone = function (milestoneId) {
    if (expandedMilestones.has(milestoneId)) {
      expandedMilestones.delete(milestoneId);
    } else {
      expandedMilestones.add(milestoneId);
    }
    renderRoadmapTab();
  }

  window.selectTask = function (skillpathId) {
    var sp = flattenRoadmapSkillpaths(roadmap).find(function (s) {
      return s.skillpath_id === skillpathId;
    });
    if (sp && hasCodingProblem(sp)) {
      vscode.postMessage({ command: 'setActiveTask', task: sp });
    }
  }

  window.generateForSkillpath = function (event, skillpathId) {
    if (event && event.stopPropagation) {
      event.stopPropagation();
    }
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
  };

  function hasCodingProblem(sp) {
    if (!sp || !Array.isArray(sp.learning_contents)) {
      return false;
    }
    return sp.learning_contents.some(function (c) {
      return c && c.content_type === 'coding_problem' && c.starter_code;
    });
  }

  // ── Hint Notification ──────────────────────────────────────────────────
  var hintTimeout = null;
  window.showHint = function (text, conceptName) {
    document.getElementById('hint-body').innerHTML = text.replace(/\\n/g, '<br>');
    var footer = document.getElementById('hint-footer');
    if (conceptName) {
      footer.textContent = '+ Added "' + conceptName + '" to your review queue';
      footer.style.display = 'block';
    } else {
      footer.style.display = 'none';
    }
    document.getElementById('hint-notif').classList.add('show');
    clearTimeout(hintTimeout);
    hintTimeout = setTimeout(closeHint, 12000);
  }
  window.closeHint = function () {
    document.getElementById('hint-notif').classList.remove('show');
  }

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

  window.retryReviews = retryReviews;
  window.startPractice = startPractice;
  window.backToList = backToList;
  window.toggleSolution = toggleSolution;
  window.grade = grade;

  // Initial render
  renderTaskTab();
})();
