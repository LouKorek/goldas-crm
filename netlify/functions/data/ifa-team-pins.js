// IFA squads found by hand, keyed by IFA player_id. Used only when a
// player's squad isn't cached yet, so the sync reads one page (his team's
// games) instead of the four the automatic lookup costs: player page, club
// list, club page, games. A pin may name the club it was found for
// (forClub, exactly as stored in currentClub); once the player's current club
// changes, that pin is ignored and the normal lookup runs again.
module.exports = {
  // Noam Barzilai: player page lists him in the squad of מכבי פ"ת עסיסי דוד
  // (נוער על), team_id 1146, ליגת העל לנוער. Checked 2026-10-09.
  '185403': { teamId: '1146', teamName: 'מכבי פתח-תקוה עסיסי דוד', ageGroup: 'נוער' },
};
