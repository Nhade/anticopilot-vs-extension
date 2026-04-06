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
        if (msg.roadmapId && msg.roadmapId !== activeRoadmapId) {
          activeRoadmapId = msg.roadmapId;
          roadmap = null;
          roadmapRequested = false;
          roadmapFetched = false;
        }
        renderTaskTab();
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
    var objectives = activeTask.learning_objectives || [];
    var objHtml =
      objectives.length > 0
        ? objectives
            .map(function (obj, i) {
              return (
                '<div class="criteria-item"><div class="checkbox' +
                (i === 0 ? ' active' : '') +
                '"></div><span>' +
                escHtml(obj) +
                '</span></div>'
              );
            })
            .join('')
        : '<div class="criteria-item"><div class="checkbox active"></div><span>Implement task requirements</span></div>';

    panel.innerHTML = [
      '<div style="display:flex;flex-direction:column;gap:16px">',
      '  <div>',
      '    <div class="badge badge-teal" style="margin-bottom:8px">Active Task</div>',
      '    <h1 class="title">' + escHtml(activeTask.title) + '</h1>',
      '  </div>',
      '  <div class="card">',
      '    <div class="section-label">Objective</div>',
      '    <p class="body-text">' + escHtml(activeTask.description || 'No description available.') + '</p>',
      '  </div>',
      '  <div class="card">',
      '    <div class="section-label">Success Criteria</div>',
      '    <div class="criteria-list">' + objHtml + '</div>',
      '  </div>',
      '  <div style="text-align:center;padding-top:4px">',
      '    <div class="section-label" style="margin-bottom:6px">Convergence Signal</div>',
      '    <div style="font-size:11px;color:var(--muted)">VS Code is synced with your roadmap.</div>',
      '  </div>',
      '</div>',
    ].join('');
  }

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
        var meta = r.concept_metadata || {};
        var name = meta.concept_name || 'Unknown Concept';
        var lang = meta.language && meta.language !== 'unknown' ? meta.language : null;
        var stateLabel = ['New', 'Learning', 'Review', 'Relearning'][r.state] || 'Learning';
        var stateClass = r.state === 2 ? 'badge-orange' : 'badge-teal';
        var dueText = formatDue(r.due);
        return [
          '<div class="review-card">',
          '  <div class="review-card-header">',
          '    <div class="review-concept-name">' + escHtml(name) + '</div>',
          '  </div>',
          '  <div class="review-meta">',
          lang ? '    <span class="badge badge-muted">' + escHtml(lang) + '</span>' : '',
          '    <span class="badge ' + stateClass + '">' + stateLabel + '</span>',
          '    <span style="font-size:11px;color:var(--muted)">' + dueText + '</span>',
          '  </div>',
          meta.misconception ? '  <div class="review-misconception">' + escHtml(meta.misconception) + '</div>' : '',
          '  <button class="practice-btn" onclick="startPractice(\'' + r.concept_id + '\')">Practice</button>',
          '</div>',
        ].join('');
      })
      .join('');

    panel.innerHTML = '<div id="review-list-check" class="review-list">' + items + '</div>';
  }

  function renderPracticeView(panel) {
    if (practiceLoading) {
      panel.innerHTML = [
        '<div class="practice-header">',
        '  <button class="back-btn" onclick="backToList()">← Back</button>',
        '  <span class="practice-concept-name">' + escHtml((activeConcept.concept_metadata || {}).concept_name || '') + '</span>',
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
      '  <span class="practice-concept-name">' + escHtml((activeConcept.concept_metadata || {}).concept_name || '') + '</span>',
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
    var skillpaths = roadmap.skillpaths || [];
    var roadmapInfo = roadmap.roadmap || {};

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
          return [
            '<div class="skillpath-item' +
              (isActive ? ' active-task' : '') +
              '" onclick="selectTask(\'' +
              sp.skillpath_id +
              '\')">',
            '  <span class="skillpath-title">' + escHtml(sp.title) + '</span>',
            hours ? '  <span class="skillpath-hours">' + hours + '</span>' : '',
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
    var sp = (roadmap && roadmap.skillpaths || []).find(function (s) {
      return s.skillpath_id === skillpathId;
    });
    if (sp) {
      vscode.postMessage({ command: 'setActiveTask', task: sp });
    }
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
    var s = text
      // Escape HTML first (except we want to render some tags)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    // Code blocks
    s = s.replace(/```[\w]*\n([\s\S]*?)```/g, function (_, code) {
      return '<pre><code>' + code.trim() + '</code></pre>';
    });
    // Inline code
    s = s.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
    // Bold
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    // Headers
    s = s.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    s = s.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    s = s.replace(/^# (.+)$/gm, '<h1>$1</h1>');
    // Bullets
    s = s.replace(/^[-\*] (.+)$/gm, '<li>$1</li>');
    s = s.replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>');
    // Paragraphs
    s = s.replace(/\n\n/g, '</p><p>');
    s = '<p>' + s + '</p>';
    // Clean up empty paragraphs
    s = s.replace(/<p>\s*<\/p>/g, '');
    return s;
  }

  window.retryReviews = retryReviews;
  window.startPractice = startPractice;
  window.backToList = backToList;
  window.toggleSolution = toggleSolution;
  window.grade = grade;

  // Initial render
  renderTaskTab();
})();
