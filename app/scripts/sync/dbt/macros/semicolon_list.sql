{#- A list column as the app's filter SQL reads it: ';'-joined, NULL when empty. -#}
{% macro semicolon_list(col) -%}
CASE WHEN {{ col }} IS NULL OR len({{ col }}) = 0 THEN NULL ELSE array_to_string({{ col }}, ';') END
{%- endmacro %}
