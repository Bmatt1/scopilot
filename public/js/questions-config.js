/**
 * Vertical-specific question config for the homeowner scoping flow.
 * Each entry defines: label, icon, and a questions array.
 *
 * Question fields:
 *   id        - key stored in trade_inputs
 *   label     - visible question text
 *   type      - "radio" | "select" | "text" | "number"
 *   options   - array of {value, label, sub?} for radio/select
 *   unit      - optional suffix for number fields (e.g. "ft")
 *   required  - whether the field must have a non-empty answer
 *
 * Adding a new vertical: add an entry here. No code changes needed.
 */
const QUESTION_CONFIG = {
  concrete: {
    label: 'Concrete',
    icon: '🏗️',
    questions: [
      {
        id: 'concrete_subtype',
        label: 'What type of concrete work?',
        type: 'radio',
        required: true,
        options: [
          { value: 'driveway',   label: 'Driveway' },
          { value: 'patio',      label: 'Patio / Pad' },
          { value: 'slab',       label: 'Garage / Shop Slab' },
          { value: 'sidewalk',   label: 'Sidewalk / Walkway' },
          { value: 'apron',      label: 'Apron / Approach' },
          { value: 'foundation', label: 'Foundation / Footing' },
        ]
      },
      {
        id: 'tear_out',
        label: 'Does existing concrete need to be removed first?',
        type: 'radio',
        required: true,
        options: [
          { value: 'no',  label: 'No — new pour' },
          { value: 'yes', label: 'Yes — tear out first' },
        ]
      },
      {
        id: 'thickness',
        label: 'Desired thickness',
        type: 'radio',
        required: true,
        options: [
          { value: '4in', label: '4 inch', sub: 'Standard driveways, patios' },
          { value: '5in', label: '5 inch', sub: 'Heavy vehicles' },
          { value: '6in', label: '6 inch', sub: 'Commercial / heavy load' },
          { value: 'unsure', label: "I'm not sure" },
        ]
      },
      {
        id: 'reinforcement',
        label: 'Reinforcement',
        type: 'radio',
        required: true,
        options: [
          { value: 'none',  label: 'None' },
          { value: 'rebar', label: 'Rebar' },
          { value: 'fiber', label: 'Fiber mesh' },
          { value: 'wire',  label: 'Wire mesh' },
        ]
      },
      {
        id: 'finish_type',
        label: 'Finish type',
        type: 'radio',
        required: true,
        options: [
          { value: 'broom',    label: 'Broom finish',       sub: 'Standard' },
          { value: 'smooth',   label: 'Smooth trowel',      sub: 'Garage, basement' },
          { value: 'exposed',  label: 'Exposed aggregate',  sub: 'Decorative' },
          { value: 'stamped',  label: 'Stamped',            sub: 'Premium' },
        ]
      },
      {
        id: 'truck_access',
        label: 'Can a concrete truck access the pour area?',
        type: 'radio',
        required: true,
        options: [
          { value: 'yes',      label: 'Yes — direct access' },
          { value: 'pump',     label: 'Will need a pump truck' },
          { value: 'unsure',   label: "I'm not sure" },
        ]
      },
    ]
  },

  excavation: {
    label: 'Excavation',
    icon: '🚜',
    questions: [
      {
        id: 'excavation_purpose',
        label: 'Purpose of excavation',
        type: 'radio',
        required: true,
        options: [
          { value: 'foundation', label: 'Foundation dig' },
          { value: 'pond',       label: 'Pond / lake' },
          { value: 'grading',    label: 'Site grading / leveling' },
          { value: 'basement',   label: 'Basement dig-out' },
          { value: 'trenching',  label: 'Trenching (utility, pipe)' },
          { value: 'other',      label: 'Other / general' },
        ]
      },
      {
        id: 'depth_ft',
        label: 'Approximate depth needed (feet)',
        type: 'radio',
        required: true,
        options: [
          { value: '1-3',  label: '1–3 ft',  sub: 'Shallow grading' },
          { value: '4-6',  label: '4–6 ft',  sub: 'Utilities, footings' },
          { value: '7-10', label: '7–10 ft', sub: 'Basement, deep foundation' },
          { value: '10+',  label: '10+ ft',  sub: 'Pond, deep excavation' },
        ]
      },
      {
        id: 'soil_type',
        label: 'Soil type (if known)',
        type: 'radio',
        required: false,
        options: [
          { value: 'loam',  label: 'Loam / dirt',    sub: 'Normal digging' },
          { value: 'clay',  label: 'Clay',            sub: 'Heavier, slower' },
          { value: 'rock',  label: 'Rock / shale',   sub: 'Much harder' },
          { value: 'mixed', label: 'Mixed / unknown' },
        ]
      },
      {
        id: 'haul_off',
        label: 'Does excavated material need to be hauled away?',
        type: 'radio',
        required: true,
        options: [
          { value: 'yes', label: 'Yes — haul off site' },
          { value: 'no',  label: 'No — spread on property' },
        ]
      },
      {
        id: 'equipment_access_ft',
        label: 'Narrowest access point for equipment (feet)',
        type: 'radio',
        required: false,
        options: [
          { value: '8+',    label: '8 ft or wider',   sub: 'Full-size excavator fits' },
          { value: '5-7',   label: '5–7 ft',           sub: 'Mid-size machine' },
          { value: 'under5',label: 'Under 5 ft',       sub: 'Mini excavator only' },
        ]
      },
    ]
  },

  drainage: {
    label: 'Drainage',
    icon: '💧',
    questions: [
      {
        id: 'drainage_problem',
        label: 'What drainage problem are you solving?',
        type: 'radio',
        required: true,
        options: [
          { value: 'standing_water',      label: 'Standing water / flooding',    sub: 'Yard stays wet' },
          { value: 'french_drain',        label: 'French drain installation' },
          { value: 'downspout_extension', label: 'Downspout extension / redirect' },
          { value: 'yard_regrade',        label: 'Yard regrading for slope' },
          { value: 'channel_drain',       label: 'Channel / trench drain (driveway, patio)' },
          { value: 'culvert',             label: 'Culvert / driveway pipe' },
        ]
      },
      {
        id: 'linear_ft',
        label: 'Approximate linear feet of drain run',
        type: 'radio',
        required: false,
        options: [
          { value: 'under25',  label: 'Under 25 ft' },
          { value: '25-75',    label: '25–75 ft' },
          { value: '75-150',   label: '75–150 ft' },
          { value: '150+',     label: '150+ ft' },
        ]
      },
      {
        id: 'outlet_location',
        label: 'Where will water drain to?',
        type: 'radio',
        required: false,
        options: [
          { value: 'street',   label: 'Street / curb' },
          { value: 'creek',    label: 'Creek / ditch on property' },
          { value: 'daylight', label: 'Daylights at edge of yard' },
          { value: 'unknown',  label: "Don't know yet" },
        ]
      },
    ]
  },

  retaining_wall: {
    label: 'Retaining Wall',
    icon: '🧱',
    questions: [
      {
        id: 'wall_material',
        label: 'Preferred wall material',
        type: 'radio',
        required: false,
        options: [
          { value: 'concrete_block', label: 'Concrete block',     sub: 'Most common' },
          { value: 'natural_stone',  label: 'Natural stone / fieldstone' },
          { value: 'timber',         label: 'Railroad tie / timber' },
          { value: 'poured_concrete',label: 'Poured concrete' },
          { value: 'undecided',      label: "Haven't decided" },
        ]
      },
      {
        id: 'wall_height_ft',
        label: 'Wall height',
        type: 'radio',
        required: true,
        options: [
          { value: 'under2',  label: 'Under 2 ft',     sub: 'Landscape edging' },
          { value: '2-4',     label: '2–4 ft',          sub: 'Common residential' },
          { value: '4-6',     label: '4–6 ft',          sub: 'May require engineer' },
          { value: '6+',      label: '6+ ft',           sub: 'Engineer required' },
        ]
      },
      {
        id: 'wall_length_ft',
        label: 'Approximate wall length',
        type: 'radio',
        required: false,
        options: [
          { value: 'under20',  label: 'Under 20 ft' },
          { value: '20-50',    label: '20–50 ft' },
          { value: '50-100',   label: '50–100 ft' },
          { value: '100+',     label: '100+ ft' },
        ]
      },
      {
        id: 'tiered',
        label: 'Single wall or tiered/terraced?',
        type: 'radio',
        required: true,
        options: [
          { value: 'single', label: 'Single wall' },
          { value: 'tiered', label: 'Tiered / terraced (multiple levels)' },
        ]
      },
      {
        id: 'drainage_behind',
        label: 'Drainage needed behind wall?',
        type: 'radio',
        required: true,
        options: [
          { value: 'yes',    label: 'Yes — add drainage gravel/pipe' },
          { value: 'no',     label: 'No' },
          { value: 'unsure', label: "Not sure — contractor to advise" },
        ]
      },
    ]
  },

  demolition: {
    label: 'Demolition',
    icon: '🏚️',
    questions: [
      {
        id: 'demo_structure',
        label: 'What is being demolished?',
        type: 'radio',
        required: true,
        options: [
          { value: 'concrete_slab',   label: 'Concrete slab / driveway' },
          { value: 'asphalt',         label: 'Asphalt driveway / parking' },
          { value: 'shed_garage',     label: 'Shed / detached garage' },
          { value: 'deck_porch',      label: 'Deck / porch' },
          { value: 'outbuilding',     label: 'Small outbuilding / barn' },
          { value: 'other',           label: 'Other structure' },
        ]
      },
      {
        id: 'demo_material',
        label: 'Primary material(s)',
        type: 'radio',
        required: true,
        options: [
          { value: 'concrete', label: 'Concrete / masonry' },
          { value: 'asphalt',  label: 'Asphalt' },
          { value: 'wood',     label: 'Wood framing / siding' },
          { value: 'mixed',    label: 'Mixed materials' },
        ]
      },
      {
        id: 'haul_off',
        label: 'Haul-off and disposal included?',
        type: 'radio',
        required: true,
        options: [
          { value: 'yes', label: 'Yes — full haul-off needed' },
          { value: 'no',  label: 'No — I will handle disposal' },
        ]
      },
    ]
  },

  land_clearing: {
    label: 'Land Clearing',
    icon: '🌲',
    questions: [
      {
        id: 'clearing_type',
        label: 'What needs to be cleared?',
        type: 'radio',
        required: true,
        options: [
          { value: 'brush_light',    label: 'Light brush / scrub' },
          { value: 'brush_heavy',    label: 'Heavy brush / undergrowth' },
          { value: 'trees_small',    label: 'Small trees (under 12" diameter)' },
          { value: 'trees_large',    label: 'Large trees (12"+ diameter)' },
          { value: 'mixed',          label: 'Mixed — trees + brush' },
        ]
      },
      {
        id: 'stump_removal',
        label: 'Stump grinding / removal needed?',
        type: 'radio',
        required: true,
        options: [
          { value: 'yes',    label: 'Yes — grind stumps' },
          { value: 'no',     label: 'No — cut flush is fine' },
          { value: 'unsure', label: "Depends on contractor's recommendation" },
        ]
      },
      {
        id: 'debris_disposal',
        label: 'What to do with debris?',
        type: 'radio',
        required: true,
        options: [
          { value: 'haul_off',  label: 'Haul off site' },
          { value: 'chip',      label: 'Chip / mulch on site' },
          { value: 'burn',      label: 'Burn on site (if permitted)' },
          { value: 'pile',      label: 'Leave in pile on property' },
        ]
      },
    ]
  },

  gravel_delivery: {
    label: 'Gravel Delivery',
    icon: '🪨',
    questions: [
      {
        id: 'gravel_type',
        label: 'Type of gravel / material needed',
        type: 'radio',
        required: true,
        options: [
          { value: 'driveway_gravel',  label: '#57 / Driveway gravel',    sub: 'Common loose stone' },
          { value: 'limestone',        label: 'Crushed limestone' },
          { value: 'pea_gravel',       label: 'Pea gravel',              sub: 'Decorative, walkways' },
          { value: 'road_base',        label: 'Road base / compactible base' },
          { value: 'fill_dirt',        label: 'Fill dirt' },
          { value: 'topsoil',          label: 'Topsoil' },
        ]
      },
      {
        id: 'depth_in',
        label: 'Desired depth / coverage',
        type: 'radio',
        required: false,
        options: [
          { value: '2in',   label: '2 inches',  sub: 'Light topdress' },
          { value: '4in',   label: '4 inches',  sub: 'Standard driveway' },
          { value: '6in',   label: '6 inches',  sub: 'Heavy use / new build' },
          { value: 'unsure',label: "I'm not sure" },
        ]
      },
      {
        id: 'spreading',
        label: 'Do you need spreading / grading included?',
        type: 'radio',
        required: true,
        options: [
          { value: 'yes', label: 'Yes — spread and grade it' },
          { value: 'no',  label: 'No — just drop delivery' },
        ]
      },
    ]
  },

  fence: {
    label: 'Fence',
    icon: '🪵',
    questions: [
      {
        id: 'fence_material',
        label: 'Fence material',
        type: 'radio',
        required: true,
        options: [
          { value: 'wood_privacy',  label: 'Wood — privacy' },
          { value: 'wood_picket',   label: 'Wood — picket' },
          { value: 'chain_link',    label: 'Chain link' },
          { value: 'vinyl',         label: 'Vinyl / PVC' },
          { value: 'aluminum',      label: 'Aluminum / steel' },
          { value: 'split_rail',    label: 'Split rail / farm fence' },
        ]
      },
      {
        id: 'fence_height_ft',
        label: 'Fence height',
        type: 'radio',
        required: true,
        options: [
          { value: '3',     label: '3 ft',    sub: 'Decorative / garden' },
          { value: '4',     label: '4 ft',    sub: 'Low privacy' },
          { value: '6',     label: '6 ft',    sub: 'Standard privacy' },
          { value: '8',     label: '8 ft',    sub: 'Maximum privacy' },
        ]
      },
      {
        id: 'remove_existing',
        label: 'Remove existing fence?',
        type: 'radio',
        required: true,
        options: [
          { value: 'no',  label: 'No — new install' },
          { value: 'yes', label: 'Yes — remove old fence first' },
        ]
      },
      {
        id: 'gates',
        label: 'Gates needed?',
        type: 'radio',
        required: false,
        options: [
          { value: 'none',     label: 'No gates' },
          { value: 'walk',     label: 'Walk gate (3–4 ft wide)' },
          { value: 'vehicle',  label: 'Vehicle gate (10–16 ft wide)' },
          { value: 'both',     label: 'Both walk and vehicle' },
        ]
      },
    ]
  }
};

// Export for Node.js (server-side) or browser (via <script> tag)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = QUESTION_CONFIG;
}
