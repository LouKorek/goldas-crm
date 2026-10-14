import React from 'react';
import { AGE_GROUPS, ageGroupFor, isYouthAge, seasonLabel, seasonStartYear } from '@goldas/domain';
import { t, getLang } from 'lib/i18n';
import { Field } from 'components/ui/UI';

// The youth age-group field of the player form (represented and candidates
// alike). The blank choice is the cohort default — the IFA rule applied to
// the current season, so it moves on its own every July 1. Picking a group
// stores a manual override tagged with this season; last season's override
// is ignored by resolveAgeGroup, so the default takes over again next season.
// Hidden for players who are not of youth age this season.
export default function AgeGroupField({ dob, value, onChange }) {
  const he = getLang() === 'he';
  if (!dob || !isYouthAge(dob)) return null;
  const def = ageGroupFor(dob);
  const season = seasonStartYear();
  const current = value?.season === season ? value.id : '';
  return (
    <Field label={`${t('Age group')} ${seasonLabel()}`}
      hint={current ? t('manual override') : t('by cohort')}>
      <select value={current} onChange={(e) => onChange(e.target.value ? { id: e.target.value, season } : null)}>
        <option value="">{def ? `${def[he ? 'he' : 'en']} · ${t('by cohort')}` : t('by cohort')}</option>
        {AGE_GROUPS.filter((x) => x.id !== def?.id).map((x) => <option key={x.id} value={x.id}>{x[he ? 'he' : 'en']}</option>)}
      </select>
    </Field>
  );
}
