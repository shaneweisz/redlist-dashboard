{#- Our taxon_group → iNaturalist's kingdom, for matching names within a kingdom.
    The same mapping as inatKingdomSql in inputs/inat-names.ts, which
    precomputed/search-index.ts still uses until that stage moves here. -#}
{% macro inat_kingdom(taxon_group) -%}
CASE
    WHEN {{ taxon_group }} IN ('flowering_plants','gymnosperms','ferns_and_allies','mosses','green_algae','red_algae') THEN 'Plantae'
    WHEN {{ taxon_group }} = 'mushrooms' THEN 'Fungi'
    WHEN {{ taxon_group }} = 'brown_algae' THEN 'Chromista'
    ELSE 'Animalia' END
{%- endmacro %}
