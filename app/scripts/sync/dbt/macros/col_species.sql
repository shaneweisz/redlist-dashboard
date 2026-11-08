{#- The CoL species the dashboard lists (species/): accepted, at species rank, and
    not demoted by the curated checklist. A predicate on the taxa source. -#}
{% macro col_species() -%}
rank = 'species' AND status = 'accepted' AND NOT demoted
{%- endmacro %}
