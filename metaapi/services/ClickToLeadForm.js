const axios = require('axios');
const { getPageToken, getUserPages } = require('../../utils/tokenExchange');

class ClickToLeadFormService {
  constructor() {
    this.baseURL = 'https://graph.facebook.com/v24.0';
  }

  /**
   * Get pages for current user
   * @param {string} userToken - User access token
   * @returns {Promise<Array>} Array of pages
   */
  async getUserPages(userToken) {
    return getUserPages(userToken);
  }

  /**
   * Get lead forms for a specific page
   * @param {string} pageId - Facebook Page ID
   * @param {string} userToken - User access token
   * @returns {Promise<Array>} Array of lead forms
   */
  async getLeadForms(pageId, userToken) {
    try {
      const pageToken = await getPageToken(userToken, pageId);
      const url = `${this.baseURL}/${pageId}/leadgen_forms`;

      const response = await axios.get(url, {
        params: {
          access_token: pageToken,
        },
      });

      return response.data.data || [];
    } catch (error) {
      const errorMessage = error.response?.data?.error?.message || error.message || 'Failed to fetch lead forms';
      console.error('Error fetching lead forms:', errorMessage);
      throw new Error(errorMessage);
    }
  }

  /**
   * Create a campaign using Meta Marketing API
   * @param {string} actAdAccountId - Ad Account ID
   * @param {string} fbToken - Facebook Access Token (user token)
   * @param {Object} campaignData - Campaign data
   * @returns {Promise<Object>} Created campaign response
   */
  async createCampaign(actAdAccountId, fbToken, campaignData) {
    try {
      const accountId = actAdAccountId.startsWith('act_') 
        ? actAdAccountId.replace('act_', '') 
        : actAdAccountId;
      
      const url = `${this.baseURL}/act_${accountId}/campaigns`;
      
      const params = new URLSearchParams();
      params.append('name', campaignData.name);
      params.append('objective', campaignData.objective);
      params.append('status', campaignData.status || 'PAUSED');
      params.append('access_token', fbToken);
      params.append('is_adset_budget_sharing_enabled', 'false');
      
      const specialAdCategories = campaignData.special_ad_categories || ['NONE'];
      params.append('special_ad_categories', JSON.stringify(specialAdCategories));

      console.log('Creating Lead Form campaign with URL:', url);
      console.log('Campaign Name:', campaignData.name);
      console.log('Objective:', campaignData.objective);

      const response = await axios.post(url, params.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });

      return response.data;
    } catch (error) {
      const errorMessage = error.response?.data?.error?.message || error.message || 'Failed to create campaign';
      const errorDetails = error.response?.data?.error || {};
      
      console.error('Meta API Error Details:', {
        message: errorMessage,
        type: errorDetails.type,
        code: errorDetails.code,
        error_subcode: errorDetails.error_subcode,
        fbtrace_id: errorDetails.fbtrace_id,
        fullError: JSON.stringify(error.response?.data, null, 2)
      });
      
      throw new Error(`${errorMessage}${errorDetails.code ? ` (Code: ${errorDetails.code})` : ''}`);
    }
  }

  /**
   * Create a lead form
   * @param {string} pageId - Facebook Page ID
   * @param {string} userToken - User access token
   * @param {Object} formData - Lead form data
   * @returns {Promise<Object>} Created lead form response
   */
  async createLeadForm(pageId, userToken, formData) {
    try {
      // Get page access token
      const pageToken = await getPageToken(userToken, pageId);
      
      const url = `${this.baseURL}/${pageId}/leadgen_forms`;
      
      const params = new URLSearchParams();
      params.append('name', formData.name);
      
      // privacy_policy is required (not privacy_policy_url)
      // Format: privacy_policy should be an object with url field
      if (formData.privacy_policy_url) {
        params.append('privacy_policy', JSON.stringify({
          url: formData.privacy_policy_url
        }));
      }
      
      if (formData.follow_up_action_url) {
        params.append('follow_up_action_url', formData.follow_up_action_url);
      }
      params.append('locale', formData.locale || 'en_US');
      params.append('access_token', pageToken);

      // Questions are required - format them properly
      // For standard question types (FULL_NAME, EMAIL, PHONE), do not include label
      let questions = formData.questions || [];
      if (questions.length === 0) {
        // Default questions if none provided - no label for standard types
        questions = [
          { type: 'FULL_NAME' },
          { type: 'EMAIL' },
          { type: 'PHONE' }
        ];
      }
      
      // Format questions properly
      // Valid standard types from Meta API
      const standardTypes = ['FULL_NAME', 'EMAIL', 'PHONE', 'FIRST_NAME', 'LAST_NAME', 'CITY', 'STATE', 'ZIP', 'POST_CODE', 'COUNTRY', 'STREET_ADDRESS', 'COMPANY_NAME', 'JOB_TITLE', 'WEBSITE'];
      
      // Map invalid types to valid ones
      const typeMapping = {
        'ZIP_CODE': 'ZIP'
      };
      
      const formattedQuestions = questions.map(q => {
        // Fix invalid type names
        let questionType = q.type;
        if (typeMapping[questionType]) {
          questionType = typeMapping[questionType];
        }
        
        const questionObj = { type: questionType };
        
        // For CUSTOM type, add label and field_type
        if (questionType === 'CUSTOM') {
          if (q.label) {
            questionObj.label = q.label;
          }
          if (q.field_type) {
            questionObj.field_type = q.field_type;
          }
          
          // Add options for MULTIPLE_CHOICE
          if (q.field_type === 'MULTIPLE_CHOICE' && q.options && q.options.length > 0) {
            questionObj.options = q.options.filter(opt => opt && opt.trim() !== '');
          }
        }
        // Standard types don't need label
        
        return questionObj;
      });
      
      params.append('questions', JSON.stringify(formattedQuestions));

      console.log('Creating lead form with URL:', url);
      console.log('Form Name:', formData.name);
      console.log('Page ID:', pageId);
      console.log('Questions being sent:', JSON.stringify(formattedQuestions, null, 2));

      const response = await axios.post(url, params.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });

      return response.data;
    } catch (error) {
      const errorMessage = error.response?.data?.error?.message || error.message || 'Failed to create lead form';
      const errorDetails = error.response?.data?.error || {};
      
      console.error('Meta API Error Details:', {
        message: errorMessage,
        type: errorDetails.type,
        code: errorDetails.code,
        error_subcode: errorDetails.error_subcode,
        fbtrace_id: errorDetails.fbtrace_id,
        fullError: JSON.stringify(error.response?.data, null, 2)
      });
      
      throw new Error(`${errorMessage}${errorDetails.code ? ` (Code: ${errorDetails.code})` : ''}`);
    }
  }

  /**
   * Create an ad set using Meta Marketing API
   * @param {string} actAdAccountId - Ad Account ID
   * @param {string} fbToken - Facebook Access Token
   * @param {Object} adsetData - Ad Set data
   * @returns {Promise<Object>} Created ad set response
   */
  async createAdSet(actAdAccountId, fbToken, adsetData) {
    try {
      const accountId = actAdAccountId.startsWith('act_') 
        ? actAdAccountId.replace('act_', '') 
        : actAdAccountId;
      
      const url = `${this.baseURL}/act_${accountId}/adsets`;
      
      const targeting = {};
      
      // Build geo_locations object
      const geoLocations = {};
      
      // Meta API doesn't allow both custom_locations and countries together (causes overlap error 1487756)
      // Priority: Use custom_locations if provided, otherwise use countries
      if (adsetData.targeting?.geo_locations?.custom_locations && adsetData.targeting.geo_locations.custom_locations.length > 0) {
        // Validate and format custom_locations
        geoLocations.custom_locations = adsetData.targeting.geo_locations.custom_locations.map(loc => ({
          latitude: parseFloat(loc.latitude),
          longitude: parseFloat(loc.longitude),
          radius: parseInt(loc.radius) || 10,
          distance_unit: loc.distance_unit || "kilometer"
        }));
        
        console.log("✅ Using custom_locations for targeting (countries excluded to avoid overlap):", geoLocations.custom_locations);
      } else if (adsetData.targeting?.geo_locations?.countries && adsetData.targeting.geo_locations.countries.length > 0) {
        // Only use countries if no custom_locations are provided
        geoLocations.countries = adsetData.targeting.geo_locations.countries;
        console.log("✅ Using countries for targeting:", geoLocations.countries);
      }
      
      // Set geo_locations in targeting if we have any location data
      if (Object.keys(geoLocations).length > 0) {
        targeting.geo_locations = geoLocations;
      }
      if (adsetData.targeting?.device_platforms && adsetData.targeting.device_platforms.length > 0) {
        targeting.device_platforms = adsetData.targeting.device_platforms;
      }
      if (adsetData.targeting?.age_min) {
        targeting.age_min = adsetData.targeting.age_min;
      }
      if (adsetData.targeting?.age_max) {
        targeting.age_max = adsetData.targeting.age_max;
      }
      if (adsetData.targeting?.genders && adsetData.targeting.genders.length > 0) {
        targeting.genders = adsetData.targeting.genders;
      }
      
      // Handle publisher platforms and positions together
      // Meta API: If positions are specified, platforms are inferred, but we should still send publisher_platforms
      // Determine platforms based on positions if not explicitly provided
      let determinedPlatforms = [];
      
      // Filter valid Facebook positions for Lead Form ads
      if (adsetData.targeting?.facebook_positions && adsetData.targeting.facebook_positions.length > 0) {
        const validFacebookPositions = ['feed', 'instant_article'];
        const filteredFacebookPositions = adsetData.targeting.facebook_positions.filter(pos => 
          validFacebookPositions.includes(pos)
        );
        if (filteredFacebookPositions.length > 0) {
          targeting.facebook_positions = filteredFacebookPositions;
          if (!determinedPlatforms.includes('facebook')) {
            determinedPlatforms.push('facebook');
          }
        }
      }
      
      // Filter valid Instagram positions
      // Valid positions: stream (feed), reels, story, explore
      // Note: If explore is selected, stream (feed) must also be included
      if (adsetData.targeting?.instagram_positions && adsetData.targeting.instagram_positions.length > 0) {
        const validInstagramPositions = ['stream', 'reels', 'story', 'explore'];
        let filteredInstagramPositions = adsetData.targeting.instagram_positions.filter(pos => 
          validInstagramPositions.includes(pos)
        );
        
        // If explore is selected, ensure stream (feed) is also included
        if (filteredInstagramPositions.includes('explore') && !filteredInstagramPositions.includes('stream')) {
          filteredInstagramPositions.push('stream');
        }
        
        if (filteredInstagramPositions.length > 0) {
          targeting.instagram_positions = filteredInstagramPositions;
          if (!determinedPlatforms.includes('instagram')) {
            determinedPlatforms.push('instagram');
          }
        }
      }
      
      // Set publisher_platforms - prioritize explicit selection, fallback to determined from positions
      // Valid values: "facebook", "instagram", "messenger", "audience_network", "threads"
      const validPlatforms = ["facebook", "instagram", "messenger", "audience_network", "threads"];
      
      if (adsetData.targeting?.publisher_platforms && adsetData.targeting.publisher_platforms.length > 0) {
        // Use explicitly provided platforms
        targeting.publisher_platforms = adsetData.targeting.publisher_platforms
          .map(p => String(p).toLowerCase())
          .filter(p => validPlatforms.includes(p));
        console.log('✅ Publisher platforms from explicit selection:', targeting.publisher_platforms);
      } else if (determinedPlatforms.length > 0) {
        // Use platforms determined from positions
        targeting.publisher_platforms = determinedPlatforms;
        console.log('✅ Publisher platforms determined from positions:', targeting.publisher_platforms);
      } else {
        // Default to facebook and instagram if nothing is provided
        targeting.publisher_platforms = ["facebook", "instagram"];
        console.log('⚠️ No publisher platforms provided, defaulting to:', targeting.publisher_platforms);
      }

      // Add detailed targeting (interests, work_positions, work_employers)
      // Meta API requires these to be in flexible_spec array format
      // Combine all detailed targeting into a single flexible_spec object
      const flexibleSpecObj = {};
      let hasDetailedTargeting = false;
      
      if (adsetData.targeting?.interests && adsetData.targeting.interests.length > 0) {
        // Ensure interests is an array of IDs (strings or numbers)
        flexibleSpecObj.interests = adsetData.targeting.interests.map(id => String(id));
        hasDetailedTargeting = true;
        console.log('✅ Adding interests to flexible_spec:', flexibleSpecObj.interests);
      }
      if (adsetData.targeting?.work_positions && adsetData.targeting.work_positions.length > 0) {
        // Ensure work_positions is an array of IDs (strings or numbers)
        flexibleSpecObj.work_positions = adsetData.targeting.work_positions.map(id => String(id));
        hasDetailedTargeting = true;
        console.log('✅ Adding work_positions to flexible_spec:', flexibleSpecObj.work_positions);
      }
      if (adsetData.targeting?.work_employers && adsetData.targeting.work_employers.length > 0) {
        // Ensure work_employers is an array of IDs (strings or numbers)
        flexibleSpecObj.work_employers = adsetData.targeting.work_employers.map(id => String(id));
        hasDetailedTargeting = true;
        console.log('✅ Adding work_employers to flexible_spec:', flexibleSpecObj.work_employers);
      }
      
      // Add flexible_spec to targeting if we have any detailed targeting
      if (hasDetailedTargeting) {
        targeting.flexible_spec = [flexibleSpecObj];
        console.log('✅ Added flexible_spec to targeting:', JSON.stringify(targeting.flexible_spec, null, 2));
      }

      // Add targeting_automation with advantage_audience flag (required by Meta API)
      // advantage_audience: 1 = enabled, 0 = disabled
      // Default to 0 (disabled) for more control
      if (!targeting.targeting_automation) {
        targeting.targeting_automation = {};
      }
      targeting.targeting_automation.advantage_audience = 0; // Default to disabled
      
      const params = new URLSearchParams();
      params.append('name', adsetData.name);
      params.append('campaign_id', adsetData.campaign_id);
      params.append('bid_strategy', 'LOWEST_COST_WITHOUT_CAP');
      params.append('daily_budget', adsetData.daily_budget);
      params.append('optimization_goal', 'LEAD_GENERATION');
      params.append('destination_type', 'ON_AD');
      params.append('billing_event', 'IMPRESSIONS');
      params.append('status', adsetData.status || 'PAUSED');
      params.append('access_token', fbToken);

      // Add promoted_object with page_id for lead ads
      // Note: leadgen_form_id is NOT part of promoted_object for ad sets
      // It should be specified in the ad creative instead
      if (adsetData.page_id) {
        const promotedObject = {
          page_id: adsetData.page_id
        };
        params.append('promoted_object', JSON.stringify(promotedObject));
      }

      if (Object.keys(targeting).length > 0) {
        params.append('targeting', JSON.stringify(targeting));
        console.log('📤 Full targeting object being sent to Meta:', JSON.stringify(targeting, null, 2));
      }

      console.log('Creating Lead Form ad set with URL:', url);
      console.log('Ad Set Name:', adsetData.name);
      console.log('Campaign ID:', adsetData.campaign_id);
      console.log('📋 Received targeting from frontend:', JSON.stringify(adsetData.targeting, null, 2));
      console.log('paramsparams =================', params);

      const response = await axios.post(url, params.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });

      return response.data;
    } catch (error) {
      const errorMessage = error.response?.data?.error?.message || error.message || 'Failed to create ad set';
      const errorDetails = error.response?.data?.error || {};
      
      console.error('Meta API Error Details:', {
        message: errorMessage,
        type: errorDetails.type,
        code: errorDetails.code,
        error_subcode: errorDetails.error_subcode,
        fbtrace_id: errorDetails.fbtrace_id,
        fullError: JSON.stringify(error.response?.data, null, 2)
      });
      
      throw new Error(`${errorMessage}${errorDetails.code ? ` (Code: ${errorDetails.code})` : ''}`);
    }
  }

  /**
   * Create an ad creative using Meta Marketing API
   * @param {string} actAdAccountId - Ad Account ID
   * @param {string} fbToken - Facebook Access Token
   * @param {Object} creativeData - Ad Creative data
   * @returns {Promise<Object>} Created ad creative response
   */
  async createAdCreative(actAdAccountId, fbToken, creativeData) {
    try {
      console.log('📥 Received creativeData:', JSON.stringify(creativeData, null, 2));
      console.log('📥 leadgen_form_id in creativeData:', creativeData.leadgen_form_id);
      
      const accountId = actAdAccountId.startsWith('act_') 
        ? actAdAccountId.replace('act_', '') 
        : actAdAccountId;
      
      const url = `${this.baseURL}/act_${accountId}/adcreatives`;
      
      // Build call_to_action - for Lead Form ads, include lead_gen_form_id in value
      const callToAction = {
        type: 'SIGN_UP'
      };
      
      // Add lead_gen_form_id to call_to_action.value if provided
      if (creativeData.leadgen_form_id) {
        callToAction.value = {
          lead_gen_form_id: creativeData.leadgen_form_id
        };
      } else {
        // Fallback to LEARN_MORE with link if no leadgen_form_id
        callToAction.type = 'LEARN_MORE';
        callToAction.value = {
          link: creativeData.business_page_url
        };
      }
      
      let objectStorySpec;
      
      // Check if video_id is provided - use video_data for videos
      if (creativeData.video_id) {
        // For video ads, use video_data
        const videoData = {
          video_id: creativeData.video_id,
          message: creativeData.primary_text || "",
          call_to_action: callToAction
        };
        
        // Add image_hash or image_url for video thumbnail (REQUIRED by Meta API)
        if (creativeData.image_hash) {
          videoData.image_hash = creativeData.image_hash;
          console.log('✅ Using image_hash for video thumbnail:', creativeData.image_hash);
        } else if (creativeData.picture_url) {
          videoData.image_url = creativeData.picture_url;
          console.log('✅ Using image_url for video thumbnail:', creativeData.picture_url);
        } else {
          console.warn('⚠️ WARNING: No image_hash or image_url provided for video thumbnail. Meta API may reject this.');
        }
        
        // Add optional fields for video_data
        // Note: Meta API does NOT support 'description' field in video_data
        if (creativeData.headline && creativeData.headline.trim()) {
          videoData.title = creativeData.headline.trim();
        }
        
        objectStorySpec = {
          page_id: creativeData.page_id,
          video_data: videoData
        };
        
        console.log('📹 Creating Lead Form video ad creative');
      } else {
        // For image ads, use link_data
        objectStorySpec = {
          page_id: creativeData.page_id,
          link_data: {
            picture: creativeData.picture_url,
            link: creativeData.business_page_url,
            name: creativeData.headline || '',
            description: creativeData.description || '',
            call_to_action: callToAction
          }
        };
        
        console.log('🖼️ Creating Lead Form image ad creative');
      }
      
      const params = new URLSearchParams();
      params.append('name', creativeData.name);
      params.append('object_story_spec', JSON.stringify(objectStorySpec));
      params.append('access_token', fbToken);
      
      // Also add promoted_object with page_id for Lead Form ads (Meta API requirement)
      if (creativeData.page_id) {
        const promotedObject = {
          page_id: creativeData.page_id
        };
        // Note: leadgen_form_id is now in call_to_action.value, not in promoted_object
        params.append('promoted_object', JSON.stringify(promotedObject));
        console.log('✅ Adding promoted_object with page_id:', promotedObject);
      }
      
      if (creativeData.leadgen_form_id) {
        console.log('✅ Lead Form ID included in call_to_action.value:', creativeData.leadgen_form_id);
      }

      console.log('Creating Lead Form ad creative with URL:', url);
      console.log('Ad Creative Name:', creativeData.name);
      console.log('Page ID:', creativeData.page_id);
      console.log('Lead Form ID:', creativeData.leadgen_form_id);
      console.log('params=====================', JSON.stringify(params));

      const response = await axios.post(url, params.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });

      return response.data;
    } catch (error) {
      const errorMessage = error.response?.data?.error?.message || error.message || 'Failed to create ad creative';
      const errorDetails = error.response?.data?.error || {};
      
      console.error('Meta API Error Details:', {
        message: errorMessage,
        type: errorDetails.type,
        code: errorDetails.code,
        error_subcode: errorDetails.error_subcode,
        fbtrace_id: errorDetails.fbtrace_id,
        fullError: JSON.stringify(error.response?.data, null, 2)
      });
      
      throw new Error(`${errorMessage}${errorDetails.code ? ` (Code: ${errorDetails.code})` : ''}`);
    }
  }

  /**
   * Create an ad using Meta Marketing API
   * @param {string} actAdAccountId - Ad Account ID
   * @param {string} fbToken - Facebook Access Token
   * @param {Object} adData - Ad data
   * @returns {Promise<Object>} Created ad response
   */
  async createAd(actAdAccountId, fbToken, adData) {
    try {
      const accountId = actAdAccountId.startsWith('act_') 
        ? actAdAccountId.replace('act_', '') 
        : actAdAccountId;
      
      const url = `${this.baseURL}/act_${accountId}/ads`;
      
      const params = new URLSearchParams();
      params.append('adset_id', adData.adset_id);
      params.append('creative', JSON.stringify({ creative_id: adData.creative_id }));
      params.append('status', adData.status || 'PAUSED');
      params.append('access_token', fbToken);
      params.append('name', adData.name || 'Click to Lead Form Ad');
      
      // Add leadgen_form_id as a separate parameter
      // Meta API requires this for Lead Form ads, even if it's also in creative's promoted_object
      // This ensures the ad is properly linked to the lead form
      if (adData.leadgen_form_id) {
        params.append('leadgen_form_id', adData.leadgen_form_id);
        console.log('✅ Adding leadgen_form_id to ad creation:', adData.leadgen_form_id);
      } else {
        console.warn('⚠️ WARNING: leadgen_form_id is missing! This may cause "Missing lead form" error.');
      }

      console.log('Creating Lead Form ad with URL:', url);
      console.log('Ad Set ID:', adData.adset_id);
      console.log('Creative ID:', adData.creative_id);
      console.log('Lead Form ID:', adData.leadgen_form_id);
      console.log('📤 Ad creation params:', {
        adset_id: adData.adset_id,
        creative: { creative_id: adData.creative_id },
        leadgen_form_id: adData.leadgen_form_id || 'MISSING',
        status: adData.status || 'PAUSED',
        name: adData.name || 'Click to Lead Form Ad'
      });

      const response = await axios.post(url, params.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });

      return response.data;
    } catch (error) {
      const errorMessage = error.response?.data?.error?.message || error.message || 'Failed to create ad';
      const errorDetails = error.response?.data?.error || {};
      
      console.error('Meta API Error Details:', {
        message: errorMessage,
        type: errorDetails.type,
        code: errorDetails.code,
        error_subcode: errorDetails.error_subcode,
        fbtrace_id: errorDetails.fbtrace_id,
        fullError: JSON.stringify(error.response?.data, null, 2)
      });
      
      throw new Error(`${errorMessage}${errorDetails.code ? ` (Code: ${errorDetails.code})` : ''}`);
    }
  }

  /**
   * Retrieve leads from a lead form
   * @param {string} leadFormId - Lead Form ID
   * @param {string} userToken - User access token
   * @param {string} pageId - Page ID
   * @returns {Promise<Array>} Array of leads
   */
  async retrieveLeads(leadFormId, userToken, pageId) {
    try {
      // Get page access token
      const pageToken = await getPageToken(userToken, pageId);
      
      const url = `${this.baseURL}/${leadFormId}/leads`;
      
      const response = await axios.get(url, {
        params: {
          access_token: pageToken
        }
      });

      return response.data.data || [];
    } catch (error) {
      const errorMessage = error.response?.data?.error?.message || error.message || 'Failed to retrieve leads';
      console.error('Error retrieving leads:', errorMessage);
      throw new Error(errorMessage);
    }
  }

  /**
   * Retrieve a specific lead by leadgen_id
   * @param {string} leadgenId - Lead ID
   * @param {string} userToken - User access token
   * @param {string} pageId - Page ID
   * @returns {Promise<Object>} Lead data
   */
  async retrieveLeadById(leadgenId, userToken, pageId) {
    try {
      // Get page access token
      const pageToken = await getPageToken(userToken, pageId);
      
      const url = `${this.baseURL}/${leadgenId}`;
      
      const response = await axios.get(url, {
        params: {
          access_token: pageToken,
          fields: 'id,created_time,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,form_id,is_organic,field_data'
        }
      });

      return response.data;
    } catch (error) {
      const errorMessage = error.response?.data?.error?.message || error.message || 'Failed to retrieve lead';
      console.error('Error retrieving lead:', errorMessage);
      throw new Error(errorMessage);
    }
  }

  /**
   * Subscribe a page to webhooks
   * @param {string} pageId - Facebook Page ID
   * @param {string} userToken - User access token
   * @returns {Promise<Object>} Subscription response
   */
  async subscribePageToWebhooks(pageId, userToken) {
    try {
      // Get page access token
      const pageToken = await getPageToken(userToken, pageId);
      
      const url = `${this.baseURL}/${pageId}/subscribed_apps`;
      
      const params = new URLSearchParams();
      params.append('subscribed_fields', 'leadgen');
      params.append('access_token', pageToken);

      console.log('Subscribing page to webhooks:', pageId);

      const response = await axios.post(url, params.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });

      return response.data;
    } catch (error) {
      const errorMessage = error.response?.data?.error?.message || error.message || 'Failed to subscribe page to webhooks';
      console.error('Error subscribing page:', errorMessage);
      throw new Error(errorMessage);
    }
  }
}

module.exports = new ClickToLeadFormService();

