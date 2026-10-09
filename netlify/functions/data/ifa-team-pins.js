// IFA squads found by hand, keyed by IFA player_id. Used only when a
// player's squad isn't cached yet, so the sync reads one page (his team's
// games) instead of the four the automatic lookup costs: player page, club
// list, club page, games. Each pin names the club it was found for; once the
// player's current club changes, the pin is ignored and the normal lookup
// runs again.
module.exports = {
};
