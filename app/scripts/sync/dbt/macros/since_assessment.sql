{#- A record (alias c: year, month, event_date) counts since the assessment if
    dated after it and by the sync date. Later years count whatever their
    precision; in the assessment's own year it needs a later day, or only a
    later month (count/record_counts.sql explains why). -#}
{% macro since_assessment(c, assessed_on, today) -%}
({{ c }}.year > year({{ assessed_on }}) AND {{ c }}.year <= year({{ today }}))
  OR ({{ c }}.year = year({{ assessed_on }}) AND CASE
        WHEN {{ c }}.event_date IS NOT NULL THEN {{ c }}.event_date > {{ assessed_on }} AND {{ c }}.event_date <= {{ today }}
        WHEN {{ c }}.month IS NOT NULL THEN {{ c }}.month > month({{ assessed_on }}) AND make_date({{ c }}.year, {{ c }}.month, 1) <= {{ today }}
        ELSE false END)
{%- endmacro %}
